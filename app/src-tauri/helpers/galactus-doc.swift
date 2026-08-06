// galactus-doc — native document reader for Galactus.
//
// Uses only Apple frameworks that ship with macOS: PDFKit for born-digital
// PDF text, Vision for OCR (offline, no network, no third-party binaries).
// Compiled on first use by the app and cached in Application Support.
//
//   galactus-doc pdftext <file.pdf>     text layer, empty if scanned
//   galactus-doc ocr <file>             OCR an image, or a scanned PDF
//   galactus-doc auto <file>            text layer, OCR fallback
//   galactus-doc info <file>            page/size summary

import Foundation
import CoreGraphics
import ImageIO
import PDFKit
import Vision

#if canImport(AppKit)
import AppKit
#endif

let RECOGNITION_LANGUAGES = ["fr-FR", "en-US", "de-DE", "es-ES", "it-IT"]
let MAX_OCR_PAGES = 40

func fail(_ message: String) -> Never {
    FileHandle.standardError.write(("galactus-doc: " + message + "\n").data(using: .utf8)!)
    exit(2)
}

/// Recognise text in a CGImage, returning lines in reading order.
func ocr(_ image: CGImage) -> String {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.usesLanguageCorrection = true
    if #available(macOS 11.0, *) {
        request.revision = VNRecognizeTextRequestRevision2
    }
    request.recognitionLanguages = RECOGNITION_LANGUAGES

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    do {
        try handler.perform([request])
    } catch {
        return ""
    }
    guard let results = request.results else { return "" }

    // Group observations into lines by vertical position, then sort by x.
    struct Piece { let text: String; let x: CGFloat; let y: CGFloat }
    var pieces: [Piece] = []
    for obs in results {
        guard let top = obs.topCandidates(1).first else { continue }
        let box = obs.boundingBox
        pieces.append(Piece(text: top.string, x: box.minX, y: box.midY))
    }
    pieces.sort { a, b in
        if abs(a.y - b.y) > 0.012 { return a.y > b.y }  // Vision origin is bottom-left
        return a.x < b.x
    }
    var lines: [String] = []
    var currentY: CGFloat = -1
    var current: [String] = []
    for p in pieces {
        if currentY < 0 || abs(p.y - currentY) <= 0.012 {
            current.append(p.text)
            if currentY < 0 { currentY = p.y }
        } else {
            lines.append(current.joined(separator: " "))
            current = [p.text]
            currentY = p.y
        }
    }
    if !current.isEmpty { lines.append(current.joined(separator: " ")) }
    return lines.joined(separator: "\n")
}

func loadImage(_ path: String) -> CGImage? {
    let url = URL(fileURLWithPath: path)
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        return nil
    }
    return image
}

func pdfTextLayer(_ path: String) -> String {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { return "" }
    var out: [String] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let text = page.string ?? ""
        if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            out.append("--- page \(i + 1) ---\n" + text)
        }
    }
    return out.joined(separator: "\n\n")
}

/// Rasterise a PDF page and OCR it — for scans with no text layer.
func pdfOcr(_ path: String) -> String {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { return "" }
    var out: [String] = []
    let pages = min(doc.pageCount, MAX_OCR_PAGES)
    for i in 0..<pages {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0  // ~144 dpi, enough for Vision
        let width = Int(bounds.width * scale)
        let height = Int(bounds.height * scale)
        guard width > 0, height > 0,
              let context = CGContext(
                data: nil, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: 0,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { continue }
        context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.scaleBy(x: scale, y: scale)
        page.draw(with: .mediaBox, to: context)
        guard let image = context.makeImage() else { continue }
        let text = ocr(image)
        if !text.isEmpty {
            out.append("--- page \(i + 1) (OCR) ---\n" + text)
        }
    }
    if doc.pageCount > pages {
        out.append("… \(doc.pageCount - pages) pages supplémentaires non traitées")
    }
    return out.joined(separator: "\n\n")
}

// ---------------------------------------------------------------- main

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: galactus-doc <pdftext|ocr|auto|info> <file>")
}
let command = args[1]
let path = args[2]
guard FileManager.default.fileExists(atPath: path) else {
    fail("file not found: \(path)")
}
let ext = (path as NSString).pathExtension.lowercased()

switch command {
case "info":
    if ext == "pdf", let doc = PDFDocument(url: URL(fileURLWithPath: path)) {
        let hasText = !pdfTextLayer(path).trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        print("pdf pages=\(doc.pageCount) textLayer=\(hasText ? "yes" : "no")")
    } else if let img = loadImage(path) {
        print("image \(img.width)x\(img.height)")
    } else {
        print("unknown")
    }

case "pdftext":
    print(pdfTextLayer(path))

case "ocr":
    if ext == "pdf" {
        print(pdfOcr(path))
    } else if let img = loadImage(path) {
        print(ocr(img))
    } else {
        fail("cannot read image: \(path)")
    }

case "auto":
    if ext == "pdf" {
        let text = pdfTextLayer(path)
        if text.trimmingCharacters(in: .whitespacesAndNewlines).count >= 40 {
            print(text)
        } else {
            let scanned = pdfOcr(path)
            print(scanned.isEmpty ? text : scanned)
        }
    } else if let img = loadImage(path) {
        print(ocr(img))
    } else {
        fail("unsupported file: \(path)")
    }

default:
    fail("unknown command: \(command)")
}
