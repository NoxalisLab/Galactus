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
//
// And editing, which is the same trade in the other direction: PDFKit reads
// the pages and Core Graphics writes them back out, so a PDF can be changed
// with no third party library, no network and no licence to review.
//
//   galactus-doc find <file.pdf> <needle>
//       where a sentence is, as JSON: page, rectangle, the matched text
//   galactus-doc replace <in.pdf> <out.pdf> <needle> <replacement>
//       cover each match and draw the replacement in its place
//   galactus-doc insert <in.pdf> <out.pdf> <page> <x> <y> <size> <text>
//       draw text at a point, page 1-based, origin bottom-left, points
//   galactus-doc append <in.pdf> <out.pdf> <size> <text>
//       add one page at the end holding the text
//
// WHAT THIS IS NOT. It does not reflow a paragraph: a PDF has no paragraphs,
// only glyphs at coordinates, and anything claiming otherwise is guessing at
// where the words were meant to go. `replace` covers the rectangle the old
// sentence occupied and draws the new one inside it, shrinking to fit; when
// the replacement is much longer than what it replaces, the JSON says by how
// much it had to shrink rather than quietly producing something unreadable.

import Foundation
import CoreGraphics
import CoreText
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

// ------------------------------------------------------------- editing

/// One place a sentence was found: which page, and the box it occupies.
struct Hit {
    let page: Int          // zero based
    let rect: CGRect       // page space, origin bottom left of the media box
    let text: String
}

func jsonString(_ s: String) -> String {
    // Foundation's encoder for one string, so quotes, backslashes, newlines
    // and anything non-ASCII come out as valid JSON rather than as a guess.
    let data = try? JSONSerialization.data(withJSONObject: [s], options: [])
    guard let data, var out = String(data: data, encoding: .utf8) else { return "\"\"" }
    out.removeFirst()  // [
    out.removeLast()   // ]
    return out
}

func findHits(_ doc: PDFDocument, _ needle: String) -> [Hit] {
    guard !needle.isEmpty else { return [] }
    var hits: [Hit] = []
    for selection in doc.findString(needle, withOptions: [.caseInsensitive]) {
        for page in selection.pages {
            let index = doc.index(for: page)
            let rect = selection.bounds(for: page)
            if rect.width <= 0 || rect.height <= 0 { continue }
            hits.append(Hit(page: index, rect: rect, text: selection.string ?? needle))
        }
    }
    return hits
}

/// The largest size at or below `start` whose line fits in `width`.
///
/// Measured rather than estimated: the width of a string depends on the font's
/// own metrics, and a replacement that overflows its box prints over whatever
/// is next to it.
func fittedSize(_ text: String, font name: String, start: CGFloat, width: CGFloat) -> CGFloat {
    var size = start
    while size > 4.5 {
        let font = CTFontCreateWithName(name as CFString, size, nil)
        let attributed = NSAttributedString(string: text, attributes: [kCTFontAttributeName as NSAttributedString.Key: font])
        let line = CTLineCreateWithAttributedString(attributed)
        if CTLineGetTypographicBounds(line, nil, nil, nil) <= Double(width) {
            return size
        }
        size -= 0.25
    }
    return 4.5
}

func drawText(_ ctx: CGContext, _ text: String, at point: CGPoint, size: CGFloat, font name: String) {
    let font = CTFontCreateWithName(name as CFString, size, nil)
    let attributed = NSAttributedString(string: text, attributes: [
        kCTFontAttributeName as NSAttributedString.Key: font,
        kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
    ])
    let line = CTLineCreateWithAttributedString(attributed)
    ctx.textPosition = point
    CTLineDraw(line, ctx)
}

/// Draw `text` inside `box`, wrapping, and return the height it used.
@discardableResult
func drawWrapped(_ ctx: CGContext, _ text: String, in box: CGRect, size: CGFloat, font name: String) -> CGFloat {
    let font = CTFontCreateWithName(name as CFString, size, nil)
    let style = NSMutableParagraphStyle()
    style.lineBreakMode = .byWordWrapping
    let attributed = NSAttributedString(string: text, attributes: [
        kCTFontAttributeName as NSAttributedString.Key: font,
        kCTForegroundColorAttributeName as NSAttributedString.Key: CGColor(red: 0, green: 0, blue: 0, alpha: 1),
        .paragraphStyle: style,
    ])
    let setter = CTFramesetterCreateWithAttributedString(attributed)
    let path = CGPath(rect: box, transform: nil)
    let frame = CTFramesetterCreateFrame(setter, CFRangeMake(0, 0), path, nil)
    CTFrameDraw(frame, ctx)
    let fitted = CTFramesetterSuggestFrameSizeWithConstraints(
        setter, CFRangeMake(0, 0), nil, CGSize(width: box.width, height: .greatestFiniteMagnitude), nil)
    return fitted.height
}

/// Copy every page of `doc` into a new PDF at `out`, letting the caller draw
/// on top of each one.
///
/// The original page is DRAWN into the new context rather than re-encoded, so
/// its text stays text and its vectors stay vectors: nothing is rasterised and
/// nothing is re-compressed. What is drawn afterwards lands on top of it, in
/// the same coordinate space the hits were measured in.
func rewritePDF(_ doc: PDFDocument, to out: String, overlay: (CGContext, Int, CGRect) -> Void) -> Bool {
    let url = URL(fileURLWithPath: out) as CFURL
    guard let ctx = CGContext(url, mediaBox: nil, nil) else { return false }
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        var box = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height)
        ctx.beginPage(mediaBox: &box)
        ctx.saveGState()
        // The media box does not have to start at the origin, and the hits are
        // measured from its corner: shifting here makes both agree.
        ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: ctx)
        ctx.restoreGState()
        overlay(ctx, i, box)
        ctx.endPage()
    }
    ctx.closePDF()
    return true
}

let DEFAULT_FONT = "Helvetica"

func commandFind(_ path: String, _ needle: String) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: path)) else { fail("not a readable PDF: \(path)") }
    let hits = findHits(doc, needle)
    let items = hits.map { h in
        "{\"page\":\(h.page + 1),\"x\":\(Int(h.rect.minX)),\"y\":\(Int(h.rect.minY))," +
        "\"width\":\(Int(h.rect.width)),\"height\":\(Int(h.rect.height)),\"text\":\(jsonString(h.text))}"
    }
    print("{\"matches\":[\(items.joined(separator: ","))]}")
}

/// Dots per inch used for a page that has to be flattened. See below.
let FLATTEN_DPI: CGFloat = 200

/// Draw a page into a bitmap, with the caller's edits on top, in page space.
func rasterise(_ page: PDFPage, overlay: (CGContext) -> Void) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    let scale = FLATTEN_DPI / 72.0
    let width = Int((bounds.width * scale).rounded())
    let height = Int((bounds.height * scale).rounded())
    guard width > 0, height > 0,
          let ctx = CGContext(
            data: nil, width: width, height: height,
            bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
    ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
    ctx.scaleBy(x: scale, y: scale)
    ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
    page.draw(with: .mediaBox, to: ctx)
    overlay(ctx)
    return ctx.makeImage()
}

func commandReplace(_ input: String, _ out: String, _ needle: String, _ replacement: String, keepText: Bool) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: input)) else { fail("not a readable PDF: \(input)") }
    let hits = findHits(doc, needle)
    if hits.isEmpty {
        // Not an error, and said in the answer rather than by writing an
        // identical file the caller would believe was edited.
        print("{\"replaced\":0,\"smallest_scale\":1.0,\"flattened_pages\":[]}")
        return
    }
    var byPage: [Int: [CGRect]] = [:]
    for h in hits { byPage[h.page, default: []].append(h.rect) }
    var smallest: CGFloat = 1.0

    // What each hit costs to hide, drawn into whichever context is used.
    let paint: (CGContext, [CGRect]) -> Void = { ctx, rects in
        for rect in rects {
            // The old sentence goes under an opaque rectangle, slightly grown
            // so antialiased glyph edges do not survive around it.
            let cover = rect.insetBy(dx: -1.0, dy: -1.0)
            ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
            ctx.fill(cover)
            // The height of the box is the best available estimate of the
            // original size: PDFKit does not hand back the font of a match.
            let start = rect.height * 0.78
            let size = fittedSize(replacement, font: DEFAULT_FONT, start: start, width: rect.width)
            if start > 0 { smallest = min(smallest, size / start) }
            let font = CTFontCreateWithName(DEFAULT_FONT as CFString, size, nil)
            let baseline = rect.minY + (rect.height - size) / 2 - CTFontGetDescent(font) / 2
            drawText(ctx, replacement, at: CGPoint(x: rect.minX, y: baseline), size: size, font: DEFAULT_FONT)
        }
    }

    // WHY THE PAGES THAT CHANGED ARE FLATTENED.
    //
    // Covering a sentence with a white rectangle hides it from the eye and
    // from nobody else: the original glyphs are still in the page's content
    // stream, so selecting the text, copying it, or running this very tool's
    // `pdftext` on the result hands back the sentence that was supposed to be
    // gone. Measured on the first version of this code, which is why the
    // rectangle is not the whole answer. A page that has an edit on it is
    // therefore re-drawn as an image, at 200 dpi, and the words underneath
    // stop existing. Pages with no edit are copied through untouched and keep
    // their text, their vectors and their size.
    //
    // `keepText` opts out for the caller who would rather have a selectable
    // text layer than a clean one, and it says so in the answer.
    let url = URL(fileURLWithPath: out) as CFURL
    guard let ctx = CGContext(url, mediaBox: nil, nil) else { fail("cannot write: \(out)") }
    var flattened: [Int] = []
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        var box = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height)
        ctx.beginPage(mediaBox: &box)
        let rects = byPage[i]
        if let rects, !keepText, let image = rasterise(page, overlay: { paint($0, rects) }) {
            ctx.draw(image, in: box)
            flattened.append(i + 1)
        } else {
            ctx.saveGState()
            ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
            page.draw(with: .mediaBox, to: ctx)
            ctx.restoreGState()
            if let rects { paint(ctx, rects) }
        }
        ctx.endPage()
    }
    ctx.closePDF()
    let rounded = (Double(smallest) * 100).rounded() / 100
    let pages = flattened.map(String.init).joined(separator: ",")
    print("{\"replaced\":\(hits.count),\"smallest_scale\":\(rounded),\"flattened_pages\":[\(pages)]}")
}

func commandInsert(_ input: String, _ out: String, _ page: Int, _ x: CGFloat, _ y: CGFloat, _ size: CGFloat, _ text: String) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: input)) else { fail("not a readable PDF: \(input)") }
    guard page >= 1, page <= doc.pageCount else {
        fail("page \(page) is outside this document, which has \(doc.pageCount)")
    }
    let ok = rewritePDF(doc, to: out) { ctx, index, box in
        guard index == page - 1 else { return }
        // Wrapped from the point to the right edge, so a long sentence stays
        // on the page instead of running off it.
        let width = max(40, box.width - x - 36)
        let area = CGRect(x: x, y: 36, width: width, height: max(size, y - 36 + size))
        drawWrapped(ctx, text, in: area, size: size, font: DEFAULT_FONT)
    }
    if !ok { fail("cannot write: \(out)") }
    print("{\"inserted\":1,\"page\":\(page)}")
}

func commandAppend(_ input: String, _ out: String, _ size: CGFloat, _ text: String) {
    guard let doc = PDFDocument(url: URL(fileURLWithPath: input)) else { fail("not a readable PDF: \(input)") }
    // The new page copies the last page's size, so a letter document does not
    // grow an A4 page at the end.
    var pageBox = CGRect(x: 0, y: 0, width: 595, height: 842)
    if doc.pageCount > 0, let last = doc.page(at: doc.pageCount - 1) {
        let b = last.bounds(for: .mediaBox)
        pageBox = CGRect(x: 0, y: 0, width: b.width, height: b.height)
    }
    let url = URL(fileURLWithPath: out) as CFURL
    guard let ctx = CGContext(url, mediaBox: nil, nil) else { fail("cannot write: \(out)") }
    for i in 0..<doc.pageCount {
        guard let page = doc.page(at: i) else { continue }
        let bounds = page.bounds(for: .mediaBox)
        var box = CGRect(x: 0, y: 0, width: bounds.width, height: bounds.height)
        ctx.beginPage(mediaBox: &box)
        ctx.saveGState()
        ctx.translateBy(x: -bounds.minX, y: -bounds.minY)
        page.draw(with: .mediaBox, to: ctx)
        ctx.restoreGState()
        ctx.endPage()
    }
    var box = pageBox
    ctx.beginPage(mediaBox: &box)
    let margin: CGFloat = 56
    let area = box.insetBy(dx: margin, dy: margin)
    drawWrapped(ctx, text, in: area, size: size, font: DEFAULT_FONT)
    ctx.endPage()
    ctx.closePDF()
    print("{\"appended\":1,\"pages\":\(doc.pageCount + 1)}")
}

// ---------------------------------------------------------------- main

let args = CommandLine.arguments
guard args.count >= 3 else {
    fail("usage: galactus-doc <pdftext|ocr|auto|info|find|replace|insert|append> <file> ...")
}
let command = args[1]
let path = args[2]
guard FileManager.default.fileExists(atPath: path) else {
    fail("file not found: \(path)")
}
let ext = (path as NSString).pathExtension.lowercased()

// The editing verbs take more arguments than the reading ones and are all
// PDF only, so they are dispatched before the reading switch rather than
// inside it. Each one exits, so nothing below runs for them.
switch command {
case "find":
    guard args.count >= 4 else { fail("usage: find <file.pdf> <needle>") }
    commandFind(path, args[3])
    exit(0)
case "replace":
    guard args.count >= 6 else { fail("usage: replace <in.pdf> <out.pdf> <needle> <replacement> [--keep-text]") }
    commandReplace(path, args[3], args[4], args[5], keepText: args.contains("--keep-text"))
    exit(0)
case "insert":
    guard args.count >= 8 else { fail("usage: insert <in.pdf> <out.pdf> <page> <x> <y> <size> <text>") }
    guard let page = Int(args[4]), let x = Double(args[5]), let y = Double(args[6]), let size = Double(args[7]) else {
        fail("page, x, y and size have to be numbers")
    }
    guard args.count >= 9 else { fail("insert needs the text to draw") }
    commandInsert(path, args[3], page, CGFloat(x), CGFloat(y), CGFloat(size), args[8])
    exit(0)
case "append":
    guard args.count >= 6 else { fail("usage: append <in.pdf> <out.pdf> <size> <text>") }
    guard let size = Double(args[4]) else { fail("size has to be a number") }
    commandAppend(path, args[3], CGFloat(size), args[5])
    exit(0)
default:
    break
}

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
