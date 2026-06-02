#pragma once

#include <juce_core/juce_core.h>

namespace postadr
{
class Diagnostics
{
public:
    static void info (const juce::String& message);
    static void error (const juce::String& message);
};
}

