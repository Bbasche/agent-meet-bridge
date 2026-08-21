import AVFoundation
import Foundation

struct Options {
    let output: String
    let voice: String?
    let rate: Float
    let text: String
}

func parseOptions() -> Options? {
    var arguments = Array(CommandLine.arguments.dropFirst())
    var output: String?
    var voice: String?
    var rate: Float = 0.52
    var textParts: [String] = []
    while !arguments.isEmpty {
        let argument = arguments.removeFirst()
        switch argument {
        case "--output":
            if arguments.isEmpty { return nil }
            output = arguments.removeFirst()
        case "--voice":
            if arguments.isEmpty { return nil }
            voice = arguments.removeFirst()
        case "--rate":
            if arguments.isEmpty { return nil }
            rate = Float(arguments.removeFirst()) ?? rate
        default:
            textParts.append(argument)
        }
    }
    guard let output, !textParts.isEmpty else { return nil }
    return Options(output: output, voice: voice, rate: rate, text: textParts.joined(separator: " "))
}

guard let options = parseOptions() else {
    FileHandle.standardError.write(Data("usage: meeting-tts --output file.caf [--voice identifier] [--rate 0.52] text\n".utf8))
    exit(2)
}

let synthesizer = AVSpeechSynthesizer()
let utterance = AVSpeechUtterance(string: options.text)
utterance.rate = options.rate
if let requestedVoice = options.voice {
    utterance.voice = AVSpeechSynthesisVoice(identifier: requestedVoice)
        ?? AVSpeechSynthesisVoice(language: requestedVoice)
}
if utterance.voice == nil {
    utterance.voice = AVSpeechSynthesisVoice(language: "en-GB")
}

let outputURL = URL(fileURLWithPath: options.output)
var audioFile: AVAudioFile?
var callbackError: Error?
var isComplete = false

synthesizer.write(utterance) { buffer in
    guard let pcm = buffer as? AVAudioPCMBuffer else { return }
    if pcm.frameLength == 0 {
        isComplete = true
        return
    }
    do {
        if audioFile == nil {
            audioFile = try AVAudioFile(forWriting: outputURL, settings: pcm.format.settings)
        }
        try audioFile?.write(from: pcm)
    } catch {
        callbackError = error
        synthesizer.stopSpeaking(at: .immediate)
        isComplete = true
    }
}

let deadline = Date().addingTimeInterval(30)
while !isComplete && Date() < deadline {
    RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(0.02))
}
if !isComplete {
    FileHandle.standardError.write(Data("speech synthesis timed out\n".utf8))
    exit(1)
}
if let callbackError {
    FileHandle.standardError.write(Data("speech synthesis failed: \(callbackError)\n".utf8))
    exit(1)
}
