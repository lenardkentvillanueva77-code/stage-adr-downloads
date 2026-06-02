#include "StudioRoutingProfile.h"

namespace postadr
{
bool StudioRoutingProfile::isProfessionalRoutingCapable (int inputChannels, int outputChannels)
{
    return inputChannels >= requiredInputChannels
        && outputChannels >= requiredOutputChannels;
}
}

