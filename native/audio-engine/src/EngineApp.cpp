#include "EngineApp.h"
#include "Diagnostics.h"
#include "EngineProtocol.h"
#include <iostream>
#include <vector>

namespace postadr
{
namespace
{
juce::var getProperty (const juce::DynamicObject& object, const juce::Identifier& name)
{
    return object.getProperty (name);
}
}

int EngineApp::run()
{
    Diagnostics::info ("Post ADR Pro Audio Engine starting");
    ipc.announceReady();

    std::string line;
    while (std::getline (std::cin, line))
    {
        const auto text = juce::String::fromUTF8 (line.data(), static_cast<int> (line.size())).trim();

        if (text.isEmpty())
            continue;

        auto parsed = juce::JSON::parse (text);
        auto* object = parsed.getDynamicObject();

        if (object == nullptr)
        {
            ipc.emitError ("invalid_json", "Expected each stdin line to be a JSON object.");
            continue;
        }

        const auto id = getProperty (*object, "id");
        const auto protocolVersion = static_cast<int> (getProperty (*object, "protocolVersion"));

        if (protocolVersion != kProtocolVersion)
        {
            ipc.emitError (id, "protocol_version_mismatch", "Unsupported protocolVersion.");
            continue;
        }

        const auto type = getProperty (*object, "type").toString();

        if (type == "engine.ping")
        {
            ipc.emitPong (id);
            continue;
        }

        if (type == "device.list")
        {
            ipc.emitDeviceListResult (id, deviceManager.listDevices());
            continue;
        }

        if (type == "device.open")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "device.open requires a payload object.");
                continue;
            }

            const auto deviceId = getProperty (*payload, "deviceId").toString();
            const auto sampleRate = static_cast<double> (getProperty (*payload, "sampleRate"));
            const auto bufferSize = static_cast<int> (getProperty (*payload, "bufferSize"));

            if (deviceId.isEmpty())
            {
                ipc.emitError (id, "invalid_payload", "device.open requires payload.deviceId.");
                continue;
            }

            const auto result = deviceManager.openProfessionalDevice (deviceId,
                                                                      sampleRate > 0.0 ? sampleRate : 48000.0,
                                                                      bufferSize > 0 ? bufferSize : 128);
            ipc.emitDeviceOpenResult (id, result.wasOk(), result.wasOk() ? "Device opened." : result.getErrorMessage());
            continue;
        }

        if (type == "device.openDiagnostic")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "device.openDiagnostic requires a payload object.");
                continue;
            }

            const auto deviceId = getProperty (*payload, "deviceId").toString();
            const auto sampleRate = static_cast<double> (getProperty (*payload, "sampleRate"));
            const auto bufferSize = static_cast<int> (getProperty (*payload, "bufferSize"));

            if (deviceId.isEmpty())
            {
                ipc.emitError (id, "invalid_payload", "device.openDiagnostic requires payload.deviceId.");
                continue;
            }

            const auto result = deviceManager.openDiagnosticDevice (deviceId,
                                                                    sampleRate > 0.0 ? sampleRate : 48000.0,
                                                                    bufferSize > 0 ? bufferSize : 128);
            ipc.emitDeviceOpenResult (id, result.wasOk(), result.wasOk() ? "Diagnostic device opened." : result.getErrorMessage());
            continue;
        }

        if (type == "meter.snapshot")
        {
            ipc.emitMeterSnapshot (id, deviceManager.getAudioGraph().getMetering());
            continue;
        }

        if (type == "routing.configure")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "routing.configure requires a payload object.");
                continue;
            }

            auto* outputs = getProperty (*payload, "outputs").getDynamicObject();
            if (outputs == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "routing.configure requires payload.outputs.");
                continue;
            }

            auto& graph = deviceManager.getAudioGraph();
            graph.setOutputRouting (static_cast<int> (getProperty (*outputs, "controlLeft")),
                                    static_cast<int> (getProperty (*outputs, "controlRight")),
                                    static_cast<int> (getProperty (*outputs, "boothLeft")),
                                    static_cast<int> (getProperty (*outputs, "boothRight")));
            ipc.emitRoutingConfigureResult (id, true, "Output routing configured.");
            continue;
        }

        if (type == "monitor.configure")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "monitor.configure requires a payload object.");
                continue;
            }

            auto& graph = deviceManager.getAudioGraph();
            graph.clearMonitoring();

            int enabledCount = 0;
            if (auto* laneArray = getProperty (*payload, "lanes").getArray())
            {
                int laneIndex = 0;
                for (const auto& laneVar : *laneArray)
                {
                    auto* laneObject = laneVar.getDynamicObject();
                    if (laneObject == nullptr)
                        continue;

                    const auto enabled = static_cast<bool> (getProperty (*laneObject, "enabled"));
                    const auto physicalInput = static_cast<int> (getProperty (*laneObject, "physicalInput"));
                    const auto gain = static_cast<float> (static_cast<double> (getProperty (*laneObject, "gain")));
                    graph.setMonitorLane (laneIndex, enabled, physicalInput, gain > 0.0f ? gain : 1.0f);
                    if (enabled)
                        ++enabledCount;
                    ++laneIndex;
                }
            }

            ipc.emitMonitorResult (id, true, enabledCount > 0 ? "Monitoring configured." : "Monitoring off.");
            continue;
        }

        if (type == "talkback.configure")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "talkback.configure requires a payload object.");
                continue;
            }

            const auto enabled = static_cast<bool> (getProperty (*payload, "enabled"));
            const auto physicalInput = static_cast<int> (getProperty (*payload, "physicalInput"));
            const auto gain = static_cast<float> (static_cast<double> (getProperty (*payload, "gain")));

            auto& graph = deviceManager.getAudioGraph();
            graph.setTalkback (enabled, physicalInput, gain > 0.0f ? gain : 1.0f);
            ipc.emitTalkbackResult (id, true, enabled ? "Talkback on." : "Talkback off.");
            continue;
        }

        if (type == "playback.start")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "playback.start requires a payload object.");
                continue;
            }

            const auto playbackId = getProperty (*payload, "playbackId").toString();
            const auto filePath = getProperty (*payload, "filePath").toString();
            const auto offsetSeconds = static_cast<double> (getProperty (*payload, "offsetSeconds"));
            const auto gain = static_cast<float> (static_cast<double> (getProperty (*payload, "gain")));
            const auto target = getProperty (*payload, "target").toString();

            auto& graph = deviceManager.getAudioGraph();
            const auto result = graph.startPlayback (playbackId,
                                                     juce::File (filePath),
                                                     offsetSeconds,
                                                     gain,
                                                     target);
            ipc.emitPlaybackResult (id,
                                    result.wasOk(),
                                    result.wasOk() ? "Playback started." : result.getErrorMessage());
            continue;
        }

        if (type == "playback.prepare")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "playback.prepare requires a payload object.");
                continue;
            }

            const auto filePath = getProperty (*payload, "filePath").toString();

            auto& graph = deviceManager.getAudioGraph();
            const auto result = graph.preparePlayback (juce::File (filePath));
            ipc.emitPlaybackResult (id,
                                    result.wasOk(),
                                    result.wasOk() ? "Playback prepared." : result.getErrorMessage());
            continue;
        }

        if (type == "playback.stop")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            const auto playbackId = payload != nullptr ? getProperty (*payload, "playbackId").toString() : juce::String();

            auto& graph = deviceManager.getAudioGraph();
            if (playbackId.isNotEmpty())
                graph.stopPlayback (playbackId);
            else
                graph.stopAllPlayback();

            ipc.emitPlaybackResult (id, true, "Playback stopped.");
            continue;
        }

        if (type == "tone.schedule")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "tone.schedule requires a payload object.");
                continue;
            }

            const auto toneId = getProperty (*payload, "toneId").toString();
            const auto delaySeconds = static_cast<double> (getProperty (*payload, "delaySeconds"));
            const auto frequencyHz = static_cast<double> (getProperty (*payload, "frequencyHz"));
            const auto durationSeconds = static_cast<double> (getProperty (*payload, "durationSeconds"));
            const auto gain = static_cast<float> (static_cast<double> (getProperty (*payload, "gain")));
            const auto target = getProperty (*payload, "target").toString();

            auto& graph = deviceManager.getAudioGraph();
            const auto result = graph.scheduleTone (toneId,
                                                    delaySeconds,
                                                    frequencyHz,
                                                    durationSeconds,
                                                    gain,
                                                    target);
            ipc.emitPlaybackResult (id,
                                    result.wasOk(),
                                    result.wasOk() ? "Tone scheduled." : result.getErrorMessage());
            continue;
        }

        if (type == "tone.stop")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            const auto toneId = payload != nullptr ? getProperty (*payload, "toneId").toString() : juce::String();

            auto& graph = deviceManager.getAudioGraph();
            if (toneId.isNotEmpty())
                graph.stopTone (toneId);
            else
                graph.stopAllTones();

            ipc.emitPlaybackResult (id, true, "Tone stopped.");
            continue;
        }

        if (type == "record.start")
        {
            auto* payload = getProperty (*object, "payload").getDynamicObject();
            if (payload == nullptr)
            {
                ipc.emitError (id, "invalid_payload", "record.start requires a payload object.");
                continue;
            }

            auto lanes = std::vector<RecordLaneConfig>();
            if (auto* laneArray = getProperty (*payload, "lanes").getArray())
            {
                for (const auto& laneVar : *laneArray)
                {
                    auto* laneObject = laneVar.getDynamicObject();
                    if (laneObject == nullptr)
                        continue;

                    RecordLaneConfig lane;
                    lane.laneId = getProperty (*laneObject, "laneId").toString();
                    lane.label = getProperty (*laneObject, "label").toString();
                    lane.physicalInput = static_cast<int> (getProperty (*laneObject, "physicalInput"));
                    lane.destination = juce::File (getProperty (*laneObject, "filePath").toString());
                    lanes.push_back (lane);
                }
            }

            const auto fallbackFilePath = getProperty (*payload, "filePath").toString();
            if (lanes.empty() && fallbackFilePath.isNotEmpty())
            {
                lanes.push_back ({ "adrMic1", "Mic 1", 0, juce::File (fallbackFilePath) });
            }

            if (lanes.empty())
            {
                ipc.emitError (id, "invalid_payload", "record.start requires at least one armed lane.");
                continue;
            }

            auto& graph = deviceManager.getAudioGraph();
            const auto sampleRate = graph.getCurrentSampleRate();
            const auto result = graph.getRecorder().startRecording (lanes, sampleRate);
            ipc.emitRecordStartResult (id,
                                       result.wasOk(),
                                       result.wasOk() ? "Recording started." : result.getErrorMessage(),
                                       result.wasOk() ? lanes.front().destination.getFullPathName() : juce::String());
            continue;
        }

        if (type == "record.stop")
        {
            auto& recorder = deviceManager.getAudioGraph().getRecorder();
            const auto status = recorder.stop();
            const auto ok = ! status.files.empty();
            ipc.emitRecordStopResult (id,
                                      ok,
                                      ok ? "Recording stopped." : "Recording stopped with no files created.",
                                      status);
            continue;
        }

        if (type == "routing.inspect")
        {
            ipc.emitRoutingInspectResult (id);
            continue;
        }

        if (type == "engine.quit")
        {
            Diagnostics::info ("Engine quit requested");
            return 0;
        }

        ipc.emitError (id, "unknown_message_type", "Unknown message type: " + type);
    }

    Diagnostics::info ("Engine stdin closed; exiting");
    return 0;
}
}
