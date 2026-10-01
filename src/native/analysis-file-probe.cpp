#include "file-probe-common.hpp"
#include <cstddef>
#include <cstring>

namespace {
using namespace file_probe;
struct Result {
    bool attempted = false;
    const char* outcome = "ERROR";
    const char* stage = "PREFLIGHT";
    DWORD error = ERROR_INVALID_DATA;
    DWORD written = 0;
    std::string observed_hash;
};
std::wstring fixture_root(const Request& request) {
    std::array<wchar_t, 512> buffer{};
    const DWORD size = GetCurrentDirectoryW(static_cast<DWORD>(buffer.size()), buffer.data());
    if (!size || size >= buffer.size()) throw 1;
    std::wstring root(buffer.data(), size);
    const auto local = L"\\work\\analysis-file-lab\\run-" + widen(request.run_id);
    const auto isolated = L"\\work\\analysis-os-lab\\run-" + widen(request.run_id);
    if (!plain_local_path(root) || (!root.ends_with(local) && !root.ends_with(isolated))) throw 1;
    // Check only the accessible root marker. Never read a denied target to authenticate it.
    Handle directory(CreateFileW(root.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
        nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    if (!directory.valid() || !same_file(directory.value, root, true)) throw 1;
    const auto marker = root + L"\\fixture-marker.txt";
    Handle file(CreateFileW(marker.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
    std::string content;
    if (!file.valid() || !same_file(file.value, marker) || !read_small(file.value, content) ||
        content != "FILE_PROBE_FIXTURE_V1\n" + request.run_id + "\nNO_USER_DATA\n") throw 1;
    return root;
}
Result execute(const Request& request) {
    Result result;
    try {
        const auto root = fixture_root(request);
        const auto target = root + L"\\" + std::wstring(paths[request.operation]);
        if (!plain_local_path(target)) return result;
        const bool read = request.operation == 0 || request.operation == 2;
        const bool append = request.operation == 1 || request.operation == 3;
        const bool create = request.operation == 4;
        const DWORD access = FILE_READ_ATTRIBUTES | (read ? GENERIC_READ : append ? FILE_APPEND_DATA : create ? GENERIC_WRITE : DELETE);
        result.attempted = true; result.stage = "OPEN";
        Handle file(CreateFileW(target.c_str(), access, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            nullptr, create ? CREATE_NEW : OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!file.valid()) { result.error = GetLastError(); return result; }
        result.stage = "GUARD";
        if (!same_file(file.value, target)) return result;
        result.stage = "IO";
        if (read) {
            std::string content;
            if (!read_small(file.value, content)) { result.error = GetLastError(); if (!result.error) result.error = ERROR_INVALID_DATA; return result; }
            result.stage = "HASH";
            result.observed_hash = sha256(content); result.outcome = "READ";
        } else if (append || create) {
            if (!WriteFile(file.value, mutation.data(), static_cast<DWORD>(mutation.size()), &result.written, nullptr)) {
                result.error = GetLastError(); return result;
            }
            if (result.written != mutation.size()) { result.error = ERROR_WRITE_FAULT; return result; }
            result.outcome = create ? "CREATED" : "APPENDED";
        } else if (request.operation == 5) {
            FILE_DISPOSITION_INFO disposition{TRUE};
            if (!SetFileInformationByHandle(file.value, FileDispositionInfo, &disposition, sizeof(disposition))) {
                result.error = GetLastError(); return result;
            }
            result.outcome = "DELETED"; // Host must verify that closing really removed this exact dummy.
        } else {
            const auto destination = root + L"\\private\\renamed.txt";
            const size_t bytes = offsetof(FILE_RENAME_INFO, FileName) + (destination.size() + 1) * sizeof(wchar_t);
            std::vector<std::byte> storage(bytes);
            auto* rename = reinterpret_cast<FILE_RENAME_INFO*>(storage.data());
            rename->ReplaceIfExists = FALSE; rename->RootDirectory = nullptr;
            rename->FileNameLength = static_cast<DWORD>(destination.size() * sizeof(wchar_t));
            std::memcpy(rename->FileName, destination.c_str(), (destination.size() + 1) * sizeof(wchar_t));
            if (!SetFileInformationByHandle(file.value, FileRenameInfo, rename, static_cast<DWORD>(bytes))) {
                result.error = GetLastError(); return result;
            }
            result.outcome = "RENAMED";
        }
        result.stage = "NONE"; result.error = ERROR_SUCCESS;
    } catch (...) { result.outcome = "ERROR"; result.error = ERROR_INVALID_DATA; }
    return result;
}
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || std::wcscmp(argv[1], L"--probe") != 0) return 2;
    try {
        if (GetFileType(GetStdHandle(STD_OUTPUT_HANDLE)) != FILE_TYPE_PIPE) return 3;
        std::string wire; file_probe::Request request;
        if (!file_probe::read_pipe(wire) || !file_probe::parse(wire, request)) return 3;
        const auto result = execute(request);
        const std::string receipt = "{\"version\":\"FILE_PROBE_RECEIPT_V1\",\"runId\":\"" + request.run_id +
            "\",\"caseId\":\"" + std::string(file_probe::cases[request.operation]) + "\",\"requestSha256\":\"" + file_probe::sha256(wire) +
            "\",\"attempted\":" + (result.attempted ? "true" : "false") + ",\"outcome\":\"" + result.outcome +
            "\",\"stage\":\"" + result.stage + "\",\"win32Error\":" + std::to_string(result.error) +
            ",\"bytesWritten\":" + std::to_string(result.written) + ",\"observedSha256\":" +
            (result.observed_hash.empty() ? "null" : "\"" + result.observed_hash + "\"") + ",\"osIsolationVerified\":false}\n";
        return file_probe::write_pipe(receipt) ? 0 : 5;
    } catch (...) { return 6; }
}
