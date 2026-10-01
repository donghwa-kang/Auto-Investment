#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdio>
#include <cwchar>
#include "analysis-validator-contract.hpp"

// Only inherited stdio is used. No target path, launcher, profile, ACL, Job or network API.
// This executable is NOT a sandbox and never dispatches the requested analysis.
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || std::wcscmp(argv[1], L"--validate") != 0) return 2;
    const HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    const HANDLE output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (GetFileType(input) != FILE_TYPE_PIPE || GetFileType(output) != FILE_TYPE_PIPE) return 3;
    char wire[analysis_validator::max_input_bytes]{};
    size_t length = 0;
    const ULONGLONG start = GetTickCount64();
    // Single-threaded, one consumer. Require EOF so a valid prefix cannot hide trailing data.
    for (;;) {
        if (GetTickCount64() - start >= 5000) return 4;
        DWORD available = 0;
        if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) {
            if (GetLastError() == ERROR_BROKEN_PIPE) break;
            return 3;
        }
        if (available == 0) { Sleep(10); continue; }
        if (available > sizeof(wire) - length) return 3;
        DWORD count = 0;
        if (!ReadFile(input, wire + length, available, &count, nullptr) || count == 0) return 3;
        length += count;
    }
    analysis_validator::Request request{};
    if (!analysis_validator::parse({wire, length}, request)) return 3;
    char receipt[512]{};
    const int size = std::snprintf(receipt, sizeof(receipt),
        "{\"status\":\"NATIVE_REQUEST_VALID_EXECUTION_LOCKED\",\"runId\":\"%.*s\","
        "\"manifestSha256\":\"%.*s\",\"inputSha256\":\"%.*s\","
        "\"executionAllowed\":false,\"actualOsTests\":\"NOT_RUN\"}\n",
        static_cast<int>(request.run_id.size()), request.run_id.data(),
        static_cast<int>(request.manifest_sha.size()), request.manifest_sha.data(),
        static_cast<int>(request.input_sha.size()), request.input_sha.data());
    if (size <= 0 || size >= static_cast<int>(sizeof(receipt))) return 5;
    DWORD written = 0;
    if (!WriteFile(output, receipt, static_cast<DWORD>(size), &written, nullptr) ||
        written != static_cast<DWORD>(size)) return 5;
    return 0;
}
