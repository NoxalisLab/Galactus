// galactus-voice — on-device speech recognition for Galactus.
//
// Uses only Apple frameworks that ship with macOS: Speech for recognition,
// AVFoundation for microphone capture. No network, no third-party binaries.
// Compiled on first use by the app and cached in Application Support.
//
//   galactus-voice check                              JSON availability report
//   galactus-voice listen [--locale fr-FR] [--max-seconds 90]
//
// listen streams `PARTIAL <text>` lines on stdout, then `FINAL <text>` and
// exits 0. Errors print `ERROR <message>` and exit 1. SIGTERM/SIGINT emit
// `FINAL <current text>` so the parent can stop listening by killing us.

import Foundation
import Speech
import AVFoundation

// Unbuffered stdout — the parent reads partial lines in streaming.
setvbuf(stdout, nil, _IONBF, 0)

func fail(_ message: String) -> Never {
    print("ERROR \(message)")
    exit(1)
}

func authStatusString(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "notDetermined"
    @unknown default: return "notDetermined"
    }
}

/// JSON-escape a plain string (locale identifiers, status words).
func jsonString(_ s: String) -> String {
    var out = ""
    for c in s.unicodeScalars {
        switch c {
        case "\"": out += "\\\""
        case "\\": out += "\\\\"
        default:
            if c.value < 0x20 {
                out += String(format: "\\u%04x", c.value)
            } else {
                out.unicodeScalars.append(c)
            }
        }
    }
    return "\"\(out)\""
}

// ---------------------------------------------------------------- listener

final class VoiceListener {
    private let recognizer: SFSpeechRecognizer
    private let localeId: String
    private let maxSeconds: TimeInterval
    private let silenceWindow: TimeInterval = 2.0

    private let engine = AVAudioEngine()
    private let request = SFSpeechAudioBufferRecognitionRequest()
    private var task: SFSpeechRecognitionTask?

    private let lock = NSLock()
    private var currentText = ""
    private var hasText = false
    private var lastChange = Date()
    private var done = false

    private let queue = DispatchQueue(label: "galactus-voice")
    private var signalSources: [DispatchSourceSignal] = []
    private var watchdog: DispatchSourceTimer?

    init(localeId: String, maxSeconds: Double) {
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
            fail("unsupported_locale \(localeId)")
        }
        self.recognizer = recognizer
        self.localeId = localeId
        self.maxSeconds = maxSeconds
    }

    func run() -> Never {
        // Signals FIRST: a SIGTERM during the permission wait must still flush
        // a FINAL line instead of dying silently.
        installSignalHandlers()
        requestPermissions()
        startRecognition()
        startWatchdog()
        dispatchMain()
    }

    /// Block until both speech and microphone permissions are resolved.
    private func requestPermissions() {
        var speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let sem = DispatchSemaphore(value: 0)
            SFSpeechRecognizer.requestAuthorization { status in
                speechStatus = status
                sem.signal()
            }
            sem.wait()
        }
        guard speechStatus == .authorized else {
            fail("permission_denied")
        }

        var micGranted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
            let sem = DispatchSemaphore(value: 0)
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                micGranted = granted
                sem.signal()
            }
            sem.wait()
        }
        guard micGranted else {
            fail("permission_denied")
        }
    }

    /// The parent stops listening by killing us: emit FINAL first.
    private func installSignalHandlers() {
        for sig in [SIGTERM, SIGINT] {
            signal(sig, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
            source.setEventHandler { [weak self] in self?.finish() }
            source.resume()
            signalSources.append(source)
        }
    }

    private func startRecognition() {
        request.shouldReportPartialResults = true
        // Prefer on-device; if the locale has no local model, fall back to the
        // system default (still Apple-local on most modern macOS setups).
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            fail("no_input_device")
        }
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            self?.request.append(buffer)
        }
        engine.prepare()
        do {
            try engine.start()
        } catch {
            fail("audio_engine \(error.localizedDescription)")
        }

        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self = self else { return }
            if let result = result {
                self.update(result.bestTranscription.formattedString, isFinal: result.isFinal)
            }
            if error != nil {
                self.lock.lock()
                let finished = self.done
                let spoke = self.hasText
                self.lock.unlock()
                if finished { return }  // teardown cancellation, ignore
                if spoke {
                    // e.g. "no speech detected" after a partial: end cleanly.
                    self.finish()
                } else {
                    fail("recognition \(error!.localizedDescription)")
                }
            }
        }
    }

    /// Poll for the two stop conditions: trailing silence and max duration.
    private func startWatchdog() {
        let deadline = Date().addingTimeInterval(maxSeconds)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        timer.schedule(deadline: .now() + 0.25, repeating: 0.25)
        timer.setEventHandler { [weak self] in
            guard let self = self else { return }
            self.lock.lock()
            let spoke = self.hasText
            let idle = Date().timeIntervalSince(self.lastChange)
            self.lock.unlock()
            if Date() >= deadline || (spoke && idle >= self.silenceWindow) {
                self.finish()
            }
        }
        timer.resume()
        watchdog = timer
    }

    private func update(_ text: String, isFinal: Bool) {
        lock.lock()
        let changed = text != currentText && !done
        if changed {
            currentText = text
            hasText = true
            lastChange = Date()
        }
        lock.unlock()
        if changed {
            print("PARTIAL \(text)")
        }
        if isFinal {
            finish()
        }
    }

    /// Print FINAL exactly once, tear down capture, exit 0.
    private func finish() {
        lock.lock()
        if done {
            lock.unlock()
            return
        }
        done = true
        let text = currentText
        lock.unlock()

        watchdog?.cancel()
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        request.endAudio()
        task?.cancel()

        print("FINAL \(text)")
        exit(0)
    }
}

// ---------------------------------------------------------------- main

let args = CommandLine.arguments
guard args.count >= 2 else {
    fail("usage: galactus-voice <check|listen> [--locale fr-FR] [--max-seconds 90]")
}
let command = args[1]

var localeId = "fr-FR"
var maxSeconds = 90.0
var i = 2
while i < args.count {
    switch args[i] {
    case "--locale":
        guard i + 1 < args.count else { fail("missing value for --locale") }
        localeId = args[i + 1]
        i += 2
    case "--max-seconds":
        guard i + 1 < args.count, let value = Double(args[i + 1]), value > 0 else {
            fail("invalid value for --max-seconds")
        }
        maxSeconds = value
        i += 2
    default:
        fail("unknown option: \(args[i])")
    }
}

switch command {
case "check":
    let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId))
    let available = recognizer?.isAvailable ?? false
    let status = authStatusString(SFSpeechRecognizer.authorizationStatus())
    print("{\"available\":\(available),\"locale\":\(jsonString(localeId)),\"authorized\":\(jsonString(status))}")
    exit(0)

case "listen":
    let listener = VoiceListener(localeId: localeId, maxSeconds: maxSeconds)
    listener.run()

default:
    fail("unknown command: \(command)")
}
