#pragma once

#include "DeviceManager.h"
#include "Metering.h"
#include "NativeRecorder.h"
#include <juce_core/juce_core.h>

namespace postadr
{
class EngineIPC
{
public:
    void announceReady() const;
    void emitPong (const juce::var& id) const;
    void emitDeviceListResult (const juce::var& id, const juce::Array<DeviceSummary>& devices) const;
    void emitDeviceOpenResult (const juce::var& id, bool ok, const juce::String& message) const;
    void emitRoutingConfigureResult (const juce::var& id, bool ok, const juce::String& message) const;
    void emitMonitorResult (const juce::var& id, bool ok, const juce::String& message) const;
    void emitTalkbackResult (const juce::var& id, bool ok, const juce::String& message) const;
    void emitPlaybackResult (const juce::var& id, bool ok, const juce::String& message) const;
    void emitRecordStartResult (const juce::var& id, bool ok, const juce::String& message, const juce::String& filePath = {}) const;
    void emitRecordStopResult (const juce::var& id, bool ok, const juce::String& message, const RecordingStatus& status = {}) const;
    void emitRoutingInspectResult (const juce::var& id) const;
    void emitMeterSnapshot (const juce::var& id, const Metering& metering) const;
    void emitError (const juce::String& code, const juce::String& message) const;
    void emitError (const juce::var& id, const juce::String& code, const juce::String& message) const;

private:
    static void writeMessage (const juce::var& message);
};
}
