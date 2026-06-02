#include "EngineIPC.h"
#include "EngineProtocol.h"
#include "StudioRoutingProfile.h"
#include <iostream>

namespace postadr
{
namespace
{
juce::var makeEnvelope (const juce::String& type, const juce::var& id = {})
{
    auto* root = new juce::DynamicObject();
    root->setProperty ("type", type);
    root->setProperty ("protocolVersion", kProtocolVersion);

    if (! id.isVoid())
        root->setProperty ("id", id);

    return root;
}

juce::var stringArrayToVar (const juce::StringArray& strings)
{
    auto array = juce::Array<juce::var>();

    for (const auto& s : strings)
        array.add (s);

    return array;
}
}

void EngineIPC::announceReady() const
{
    auto message = makeEnvelope ("engine.ready");
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("engineVersion", kEngineVersion);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitPong (const juce::var& id) const
{
    auto message = makeEnvelope ("engine.pong", id);
    message.getDynamicObject()->setProperty ("payload", new juce::DynamicObject());
    writeMessage (message);
}

void EngineIPC::emitDeviceListResult (const juce::var& id, const juce::Array<DeviceSummary>& devices) const
{
    auto message = makeEnvelope ("device.list.result", id);
    auto* payload = new juce::DynamicObject();
    auto deviceArray = juce::Array<juce::var>();

    for (const auto& device : devices)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty ("deviceId", device.id);
        item->setProperty ("name", device.name);
        item->setProperty ("backend", device.backend);
        item->setProperty ("inputDeviceName", device.inputDeviceName);
        item->setProperty ("outputDeviceName", device.outputDeviceName);
        item->setProperty ("inputChannelCount", device.inputChannelCount);
        item->setProperty ("outputChannelCount", device.outputChannelCount);
        item->setProperty ("availableInputDeviceNames", stringArrayToVar (device.availableInputDeviceNames));
        item->setProperty ("inputChannelNames", stringArrayToVar (device.inputChannelNames));
        item->setProperty ("outputChannelNames", stringArrayToVar (device.outputChannelNames));
        item->setProperty ("isProfessionalRoutingCapable", device.isProfessionalRoutingCapable);
        deviceArray.add (item);
    }

    payload->setProperty ("devices", deviceArray);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitDeviceOpenResult (const juce::var& id, bool ok, const juce::String& resultMessage) const
{
    auto message = makeEnvelope ("device.open.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitRoutingConfigureResult (const juce::var& id, bool ok, const juce::String& resultMessage) const
{
    auto message = makeEnvelope ("routing.configure.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitMonitorResult (const juce::var& id, bool ok, const juce::String& resultMessage) const
{
    auto message = makeEnvelope ("monitor.configure.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitTalkbackResult (const juce::var& id, bool ok, const juce::String& resultMessage) const
{
    auto message = makeEnvelope ("talkback.configure.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitPlaybackResult (const juce::var& id, bool ok, const juce::String& resultMessage) const
{
    auto message = makeEnvelope ("playback.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitRecordStartResult (const juce::var& id,
                                       bool ok,
                                       const juce::String& resultMessage,
                                       const juce::String& filePath) const
{
    auto message = makeEnvelope ("record.start.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    payload->setProperty ("filePath", filePath);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitRecordStopResult (const juce::var& id,
                                      bool ok,
                                      const juce::String& resultMessage,
                                      const RecordingStatus& status) const
{
    auto message = makeEnvelope ("record.stop.result", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("ok", ok);
    payload->setProperty ("message", resultMessage);
    payload->setProperty ("filePath", status.files.empty() ? juce::String() : status.files.front().filePath);
    payload->setProperty ("samplesWritten", static_cast<double> (status.samplesWritten));
    payload->setProperty ("droppedBlocks", static_cast<double> (status.droppedBlocks));
    payload->setProperty ("sampleRate", status.sampleRate);
    payload->setProperty ("durationSecs", status.sampleRate > 0.0
                                               ? static_cast<double> (status.samplesWritten) / status.sampleRate
                                               : 0.0);
    auto files = juce::Array<juce::var>();
    for (const auto& file : status.files)
    {
        auto* item = new juce::DynamicObject();
        item->setProperty ("laneId", file.laneId);
        item->setProperty ("label", file.label);
        item->setProperty ("physicalInput", file.physicalInput);
        item->setProperty ("filePath", file.filePath);
        item->setProperty ("samplesWritten", static_cast<double> (file.samplesWritten));
        item->setProperty ("droppedBlocks", static_cast<double> (file.droppedBlocks));
        item->setProperty ("durationSecs", status.sampleRate > 0.0
                                               ? static_cast<double> (file.samplesWritten) / status.sampleRate
                                               : 0.0);
        files.add (item);
    }
    payload->setProperty ("files", files);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitRoutingInspectResult (const juce::var& id) const
{
    auto message = makeEnvelope ("routing.inspect.result", id);
    auto* payload = new juce::DynamicObject();

    auto* inputs = new juce::DynamicObject();
    inputs->setProperty ("adrMic1", StudioRoutingProfile::adrMic1Input);
    inputs->setProperty ("adrMic2", StudioRoutingProfile::adrMic2Input);
    inputs->setProperty ("talkbackMic", StudioRoutingProfile::talkbackInput);

    auto* outputs = new juce::DynamicObject();
    outputs->setProperty ("control", juce::Array<juce::var> {
        StudioRoutingProfile::controlLeftOutput,
        StudioRoutingProfile::controlRightOutput
    });
    outputs->setProperty ("booth", juce::Array<juce::var> {
        StudioRoutingProfile::boothLeftOutput,
        StudioRoutingProfile::boothRightOutput
    });

    auto* talkbackRoute = new juce::DynamicObject();
    talkbackRoute->setProperty ("source", "talkbackMic");
    talkbackRoute->setProperty ("destinations", juce::Array<juce::var> { "boothL", "boothR" });
    talkbackRoute->setProperty ("recorded", false);

    payload->setProperty ("profile", kRoutingProfileId);
    payload->setProperty ("inputs", inputs);
    payload->setProperty ("outputs", outputs);
    payload->setProperty ("recordBus", juce::Array<juce::var> { "adrMic1" });
    payload->setProperty ("talkbackRoute", talkbackRoute);

    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitMeterSnapshot (const juce::var& id, const Metering& metering) const
{
    auto message = makeEnvelope ("meter.snapshot", id);
    auto* payload = new juce::DynamicObject();

    auto inputArray = juce::Array<juce::var>();
    for (const auto peak : metering.getInputPeaks())
        inputArray.add (peak);

    auto outputArray = juce::Array<juce::var>();
    for (const auto peak : metering.getOutputPeaks())
        outputArray.add (peak);

    payload->setProperty ("inputs", inputArray);
    payload->setProperty ("outputs", outputArray);
    payload->setProperty ("callbackCount", static_cast<double> (metering.getCallbackCount()));
    payload->setProperty ("lastInputChannelCount", metering.getLastInputChannelCount());
    payload->setProperty ("lastOutputChannelCount", metering.getLastOutputChannelCount());
    payload->setProperty ("lastBufferSize", metering.getLastBufferSize());
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::emitError (const juce::String& code, const juce::String& message) const
{
    emitError ({}, code, message);
}

void EngineIPC::emitError (const juce::var& id, const juce::String& code, const juce::String& errorMessage) const
{
    auto message = makeEnvelope ("engine.error", id);
    auto* payload = new juce::DynamicObject();
    payload->setProperty ("code", code);
    payload->setProperty ("message", errorMessage);
    message.getDynamicObject()->setProperty ("payload", payload);
    writeMessage (message);
}

void EngineIPC::writeMessage (const juce::var& message)
{
    std::cout << juce::JSON::toString (message, true) << std::endl;
}
}
