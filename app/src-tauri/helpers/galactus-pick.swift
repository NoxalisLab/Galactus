// galactus-pick — the folder chooser, natively.
//
// WHY THIS EXISTS. The app asked osascript for `choose folder`, and on the
// machine this was written for macOS answered "cancelled by the user" without
// anybody cancelling anything: an Apple Event from a hardened app, sent by a
// process with no UI session of its own, cannot present a panel and the refusal
// arrives dressed as a cancel. Four rounds were spent on that disguise.
//
// NSOpenPanel is not an Apple Event. It needs no Automation permission, no
// usage description and no cooperation from another process: it is this
// process's own window. `activate(ignoringOtherApps:)` is what puts it in front
// of the app that launched us, which is the other half of the old problem, the
// panel that opened behind the window and looked like nothing at all.
//
//   galactus-pick folder [start-path]     prints the chosen POSIX path
//   galactus-pick image  [start-path]     same panel, one image file
//   galactus-pick audio  [start-path]     same panel, one WAV file
//
// Exit codes are the contract, because a path is not the only outcome:
//   0  a folder was chosen, its path is on stdout
//   2  the user cancelled, which is not an error and must not read as one
//   1  anything else, with a reason on stderr

import AppKit
import Foundation
import UniformTypeIdentifiers

let args = Array(CommandLine.arguments.dropFirst())
let mode = args.first ?? ""
guard mode == "folder" || mode == "image" || mode == "audio" else {
    FileHandle.standardError.write("usage: galactus-pick folder|image|audio [start-path]\n".data(using: .utf8)!)
    exit(1)
}

// Accessory, not regular: the process shows a panel and dies. A regular app
// would put an icon in the Dock and steal the menu bar for the second it lives.
let app = NSApplication.shared
app.setActivationPolicy(.accessory)

let panel = NSOpenPanel()
if mode == "audio" {
    // One WAV, for the speech-to-video models. WAV only: the engine parses
    // PCM WAV itself and converts to 16 kHz mono internally.
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [UTType.wav]
} else if mode == "image" {
    // One image, for the video models that animate a starting picture. The
    // engine reads PNG and JPEG through stb; the panel offers exactly those
    // rather than letting a .heic through to fail inside a log.
    panel.canChooseDirectories = false
    panel.canChooseFiles = true
    panel.allowedContentTypes = [UTType.png, UTType.jpeg]
} else {
    panel.canChooseDirectories = true
    panel.canChooseFiles = false
    panel.canCreateDirectories = true
}
panel.allowsMultipleSelection = false
panel.prompt = "Choose"

// Where it opens. A path that no longer exists is dropped rather than passed
// on: AppKit would fall back on its own, but silently, and a caller that
// believed it had set a starting point deserves the same result either way.
if args.count > 1, !args[1].isEmpty {
    var isDir: ObjCBool = false
    if FileManager.default.fileExists(atPath: args[1], isDirectory: &isDir), isDir.boolValue {
        panel.directoryURL = URL(fileURLWithPath: args[1], isDirectory: true)
    }
}

app.activate(ignoringOtherApps: true)
let response = panel.runModal()

if response == .OK, let url = panel.url {
    FileHandle.standardOutput.write((url.path + "\n").data(using: .utf8)!)
    exit(0)
}
exit(2)
