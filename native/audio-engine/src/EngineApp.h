#pragma once

#include "DeviceManager.h"
#include "EngineIPC.h"

namespace postadr
{
class EngineApp
{
public:
    int run();

private:
    DeviceManager deviceManager;
    EngineIPC ipc;
};
}

