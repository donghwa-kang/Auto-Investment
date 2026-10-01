#pragma once
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <bcrypt.h>
#include <array>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
#include "analysis-validator-contract.hpp"

namespace file_probe {
struct Handle {
    HANDLE value = INVALID_HANDLE_VALUE;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    Handle(Handle&& other) noexcept : value(std::exchange(other.value, INVALID_HANDLE_VALUE)) {}
    Handle& operator=(Handle&& other) noexcept {
        if (this != &other) { reset(); value = std::exchange(other.value, INVALID_HANDLE_VALUE); }
        return *this;
    }
    ~Handle() { reset(); }
    bool valid() const noexcept { return value && value != INVALID_HANDLE_VALUE; }
    void reset() noexcept { if (valid()) CloseHandle(value); value = INVALID_HANDLE_VALUE; }
};
inline std::string sha256(std::string_view data) {
    std::array<UCHAR, 32> result{};
    if (data.size() > 2097152 || BCryptHash(BCRYPT_SHA256_ALG_HANDLE, nullptr, 0,
        reinterpret_cast<PUCHAR>(const_cast<char*>(data.data())), static_cast<ULONG>(data.size()),
        result.data(), static_cast<ULONG>(result.size())) < 0) throw 1;
    std::string text;
    text.reserve(64);
    for (UCHAR c : result) { text += "0123456789abcdef"[c >> 4]; text += "0123456789abcdef"[c & 15]; }
    return text;
}
inline bool read_pipe(std::string& wire, size_t limit = 384) {
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    if (GetFileType(in) != FILE_TYPE_PIPE) return false;
    const ULONGLONG start = GetTickCount64();
    std::array<char, 384> buffer{};
    while (GetTickCount64() - start < 5000) {
        DWORD available = 0;
        if (!PeekNamedPipe(in, nullptr, 0, nullptr, &available, nullptr))
            return GetLastError() == ERROR_BROKEN_PIPE;
        if (!available) { Sleep(10); continue; }
        if (available > buffer.size() || wire.size() + available > limit) return false;
        DWORD read = 0;
        if (!ReadFile(in, buffer.data(), available, &read, nullptr) || !read) return false;
        wire.append(buffer.data(), read);
    }
    return false;
}
inline bool write_pipe(std::string_view wire) {
    HANDLE out = GetStdHandle(STD_OUTPUT_HANDLE);
    if (wire.size() > 8192 || GetFileType(out) != FILE_TYPE_PIPE) return false;
    DWORD written = 0;
    return WriteFile(out, wire.data(), static_cast<DWORD>(wire.size()), &written, nullptr) && written == wire.size();
}
constexpr std::array<std::string_view, 7> cases{
    "ALLOW_READ", "ALLOW_WRITE", "DENY_READ", "DENY_APPEND", "DENY_CREATE", "DENY_DELETE", "DENY_RENAME"
};
constexpr std::array<std::wstring_view, 7> paths{
    L"input\\allow.txt", L"scratch\\write.txt", L"private\\read.txt", L"private\\append.txt",
    L"private\\create.txt", L"private\\delete.txt", L"private\\rename.txt"
};
constexpr std::string_view mutation = "FILE_PROBE_MUTATION_V1\n";
struct Request { std::string run_id, manifest_sha; size_t operation = 0; };
inline bool parse(std::string_view wire, Request& request) {
    std::array<std::string_view, 7> fields{};
    size_t position = 0;
    for (auto& field : fields) {
        size_t end = wire.find('\n', position);
        if (end == std::string_view::npos) return false;
        field = wire.substr(position, end - position); position = end + 1;
    }
    if (wire.size() > 384 || position != wire.size() || fields[0] != "FILE_PROBE_REQUEST_V1" ||
        !analysis_validator::uuid(fields[1]) || !analysis_validator::hash(fields[3]) ||
        fields[4] != "GENERATED_DUMMY_ONLY" || fields[5] != "NO_OS_ATTESTATION" || fields[6] != "END") return false;
    size_t operation = 0;
    while (operation < cases.size() && fields[2] != cases[operation]) ++operation;
    if (operation == cases.size()) return false;
    request = {std::string(fields[1]), std::string(fields[3]), operation};
    return true;
}
inline std::wstring widen(std::string_view text) { return {text.begin(), text.end()}; }
inline bool plain_local_path(std::wstring_view path) {
    if (path.size() < 4 || path.size() > 220 || path[0] < L'A' || path[0] > L'Z' ||
        path[1] != L':' || path[2] != L'\\' || path.back() == L'\\') return false;
    size_t position = 3;
    while (position < path.size()) {
        const size_t end = path.find(L'\\', position);
        const auto part = path.substr(position, end == std::wstring_view::npos ? path.size() - position : end - position);
        if (part.empty() || part == L"." || part == L".." || part.back() == L'.' || part.back() == L' ') return false;
        for (wchar_t c : part) if (c < 32 || std::wstring_view(L"<>:\"/|?*").find(c) != std::wstring_view::npos) return false;
        if (end == std::wstring_view::npos) break;
        position = end + 1;
    }
    return true;
}
inline bool same_file(HANDLE h, const std::wstring& path, bool directory = false) {
    BY_HANDLE_FILE_INFORMATION info{};
    if (GetFileType(h) != FILE_TYPE_DISK || !GetFileInformationByHandle(h, &info) ||
        (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
        !!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != directory ||
        (!directory && (info.nNumberOfLinks != 1 || info.nFileSizeHigh || info.nFileSizeLow > 2097152))) return false;
    std::array<wchar_t, 512> final{};
    DWORD size = GetFinalPathNameByHandleW(h, final.data(), static_cast<DWORD>(final.size()), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    return size && size < final.size() && _wcsicmp(final.data(), (L"\\\\?\\" + path).c_str()) == 0;
}
inline bool read_small(HANDLE file, std::string& bytes, size_t max = 4096) {
    std::array<char, 4097> buffer{};
    if (max > 4096) { SetLastError(ERROR_INVALID_PARAMETER); return false; }
    DWORD count = 0;
    if (!ReadFile(file, buffer.data(), static_cast<DWORD>(max + 1), &count, nullptr)) return false;
    if (count > max) { SetLastError(ERROR_FILE_TOO_LARGE); return false; }
    bytes.assign(buffer.data(), count); return true;
}
} // namespace file_probe
