package com.octacode.agent.shizuku;

oneway interface IDeviceShellCallback {
    void onOutput(String sessionId, in byte[] data);
    void onExit(String sessionId, int exitCode);
}
