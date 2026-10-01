#include "isolation-win32.hpp"
#include <sddl.h>
#include <userenv.h>
#include <algorithm>

namespace isolation {
namespace {
using file_probe::Handle;
class Win32Backend final : public Backend {
    NativeConfig config;
    file_probe::Request request;
    std::vector<Handle> directories;
    Handle executable, job, in_read, in_write, out_read, out_write, err_read, err_write, process, thread;
    PSID sid = nullptr;
    std::vector<std::byte> attribute_storage;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = nullptr;
    SECURITY_CAPABILITIES capabilities{};
    DWORD opt_out = PROCESS_CREATION_ALL_APPLICATION_PACKAGES_OPT_OUT;
    DWORD child_policy = PROCESS_CREATION_CHILD_PROCESS_RESTRICTED;
    std::array<HANDLE, 3> inherited{};
    ULONGLONG started = 0;
    std::string output;
    bool out_eof = false, err_eof = false;

    bool pin_directory(const std::wstring& path) {
        Handle handle(CreateFileW(path.c_str(), FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE,
            nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!handle.valid() || !file_probe::same_file(handle.value, path, true)) return false;
        directories.push_back(std::move(handle)); return true;
    }
    bool preflight() {
        if (!file_probe::parse(config.request, request) || !file_probe::plain_local_path(config.root) ||
            !analysis_validator::hash(config.probe_sha256) ||
            !config.root.ends_with(L"\\work\\analysis-os-lab\\run-" + file_probe::widen(request.run_id))) return false;
        // Host-side provisioning/ACL attestation is deliberately not implemented here.
        // This adapter consumes a future verified layout; the public controller stays hard-locked.
        for (size_t end = 3; end < config.root.size(); ++end)
            if (config.root[end] == L'\\' && !pin_directory(config.root.substr(0, end))) return false;
        if (!pin_directory(config.root)) return false;
        for (const auto* role : {L"bin", L"input", L"private", L"scratch", L"profile", L"evidence"})
            if (!pin_directory(config.root + L"\\" + role)) return false;
        const auto path = config.root + L"\\bin\\analysis-file-probe.exe";
        if (!file_probe::plain_local_path(path)) return false;
        executable = Handle(CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
        if (!executable.valid() || !file_probe::same_file(executable.value, path)) return false;
        LARGE_INTEGER size{};
        if (!GetFileSizeEx(executable.value, &size) || size.QuadPart <= 0 || size.QuadPart > 2097152) return false;
        std::string bytes(static_cast<size_t>(size.QuadPart), '\0'); DWORD count = 0;
        if (!ReadFile(executable.value, bytes.data(), static_cast<DWORD>(bytes.size()), &count, nullptr) ||
            count != bytes.size() || file_probe::sha256(bytes) != config.probe_sha256) return false;
        if (!config.profile_sid.starts_with(L"S-1-15-2-") || !ConvertStringSidToSidW(config.profile_sid.c_str(), &sid) || !IsValidSid(sid)) return false;
        std::string compact = request.run_id; compact.erase(std::remove(compact.begin(), compact.end(), '-'), compact.end());
        PSID derived = nullptr;
        const HRESULT hr = DeriveAppContainerSidFromAppContainerName((L"PaperLab.Analysis.Offline.v1." + file_probe::widen(compact)).c_str(), &derived);
        const bool matches = SUCCEEDED(hr) && derived && EqualSid(sid, derived);
        if (derived) FreeSid(derived);
        return matches;
    }
    static constexpr DWORD flags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY | JOB_OBJECT_LIMIT_JOB_TIME;
    bool verify_job() {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        return QueryInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits), nullptr) &&
            limits.BasicLimitInformation.LimitFlags == flags && limits.BasicLimitInformation.ActiveProcessLimit == 1 &&
            limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart == 20000000 && limits.JobMemoryLimit == 128ULL * 1024 * 1024;
    }
    bool create_job() {
        started = GetTickCount64(); job = Handle(CreateJobObjectW(nullptr, nullptr));
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = flags;
        limits.BasicLimitInformation.ActiveProcessLimit = 1;
        limits.BasicLimitInformation.PerJobUserTimeLimit.QuadPart = 20000000;
        limits.JobMemoryLimit = 128ULL * 1024 * 1024;
        return job.valid() && SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) && verify_job();
    }
    bool pipe(Handle& read, Handle& write, bool parent_read) {
        SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
        HANDLE r = nullptr, w = nullptr;
        if (!CreatePipe(&r, &w, &security, 4096)) return false;
        read = Handle(r); write = Handle(w);
        return SetHandleInformation(parent_read ? r : w, HANDLE_FLAG_INHERIT, 0) != FALSE;
    }
    bool build_attributes() {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, 5, 0, &size);
        if (!size || size > 65536) return false;
        attribute_storage.resize(size);
        auto* candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
        if (!InitializeProcThreadAttributeList(candidate, 5, 0, &size)) return false;
        attributes = candidate;
        capabilities.AppContainerSid = sid; // Capability count remains exactly zero.
        inherited = {in_read.value, out_write.value, err_write.value};
        for (HANDLE h : inherited) { DWORD f = 0; if (!GetHandleInformation(h, &f) || !(f & HANDLE_FLAG_INHERIT)) return false; }
        return UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), nullptr, nullptr) &&
            UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_ALL_APPLICATION_PACKAGES_POLICY, &opt_out, sizeof(opt_out), nullptr, nullptr) &&
            UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_CHILD_PROCESS_POLICY, &child_policy, sizeof(child_policy), nullptr, nullptr) &&
            UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited.data(), sizeof(inherited), nullptr, nullptr) &&
            UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(job.value), nullptr, nullptr);
    }
    bool create_suspended() {
        STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = in_read.value; startup.StartupInfo.hStdOutput = out_write.value; startup.StartupInfo.hStdError = err_write.value;
        startup.lpAttributeList = attributes;
        const auto path = config.root + L"\\bin\\analysis-file-probe.exe";
        std::wstring command = L"\"" + path + L"\" --probe";
        std::wstring environment;
        // Sorted, explicit child environment; no user home, auth, proxy, PATH or model variables.
        const std::array<std::wstring, 4> entries{L"SystemRoot=C:\\Windows", L"TEMP=" + config.root + L"\\scratch", L"TMP=" + config.root + L"\\scratch", L"WINDIR=C:\\Windows"};
        for (const auto& entry : entries) {
            environment.append(entry); environment.push_back(L'\0');
        }
        environment.push_back(L'\0');
        PROCESS_INFORMATION info{};
        if (!CreateProcessW(path.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
            environment.data(), config.root.c_str(), &startup.StartupInfo, &info)) return false;
        process = Handle(info.hProcess); thread = Handle(info.hThread);
        in_read.reset(); out_write.reset(); err_write.reset();
        return true;
    }
    static bool token_dword(HANDLE token, TOKEN_INFORMATION_CLASS info, DWORD expected) {
        DWORD value = 0, bytes = 0;
        return GetTokenInformation(token, info, &value, sizeof(value), &bytes) && bytes == sizeof(value) && value == expected;
    }
    static std::vector<std::byte> token_info(HANDLE token, TOKEN_INFORMATION_CLASS info) {
        DWORD size = 0; GetTokenInformation(token, info, nullptr, 0, &size);
        if (!size || size > 8192) return {};
        std::vector<std::byte> bytes(size);
        if (!GetTokenInformation(token, info, bytes.data(), size, &size)) return {};
        return bytes;
    }
    bool identity() {
        BOOL belongs = FALSE;
        if (!IsProcessInJob(process.value, job.value, &belongs) || !belongs || !verify_job()) return false;
        HANDLE raw = nullptr;
        if (!OpenProcessToken(process.value, TOKEN_QUERY, &raw)) return false;
        Handle token(raw);
        if (!token_dword(token.value, TokenIsAppContainer, 1) || !token_dword(token.value, TokenIsLessPrivilegedAppContainer, 1)) return false;
        const auto app = token_info(token.value, TokenAppContainerSid);
        const auto caps = token_info(token.value, TokenCapabilities);
        const auto integrity = token_info(token.value, TokenIntegrityLevel);
        if (app.size() < sizeof(TOKEN_APPCONTAINER_INFORMATION) || caps.size() < sizeof(DWORD) || integrity.size() < sizeof(TOKEN_MANDATORY_LABEL)) return false;
        const auto* app_info = reinterpret_cast<const TOKEN_APPCONTAINER_INFORMATION*>(app.data());
        const auto* groups = reinterpret_cast<const TOKEN_GROUPS*>(caps.data());
        const auto* label = reinterpret_cast<const TOKEN_MANDATORY_LABEL*>(integrity.data());
        if (!app_info->TokenAppContainer || !IsValidSid(app_info->TokenAppContainer) || !EqualSid(sid, app_info->TokenAppContainer) ||
            groups->GroupCount != 0 || !IsValidSid(label->Label.Sid)) return false;
        const auto count = *GetSidSubAuthorityCount(label->Label.Sid);
        if (!count || *GetSidSubAuthority(label->Label.Sid, count - 1) > SECURITY_MANDATORY_LOW_RID) return false;
        PROCESS_MITIGATION_CHILD_PROCESS_POLICY policy{};
        return GetProcessMitigationPolicy(process.value, ProcessChildProcessPolicy, &policy, sizeof(policy)) && policy.NoChildProcessCreation;
    }
    bool drain(HANDLE pipe_handle, bool& eof, bool stderr_pipe) {
        DWORD available = 0;
        if (!PeekNamedPipe(pipe_handle, nullptr, 0, nullptr, &available, nullptr)) {
            eof = GetLastError() == ERROR_BROKEN_PIPE; return eof;
        }
        if (!available) return true;
        if (stderr_pipe || available > 8192 - output.size()) return false;
        std::array<char, 8192> buffer{}; DWORD count = 0;
        if (!ReadFile(pipe_handle, buffer.data(), available, &count, nullptr) || !count) return false;
        output.append(buffer.data(), count); return true;
    }
    bool exchange() {
        DWORD count = 0;
        if (!WriteFile(in_write.value, config.request.data(), static_cast<DWORD>(config.request.size()), &count, nullptr) || count != config.request.size()) return false;
        in_write.reset();
        while (GetTickCount64() - started < 10000) {
            if (!drain(out_read.value, out_eof, false) || !drain(err_read.value, err_eof, true)) return false;
            const DWORD wait = WaitForSingleObject(process.value, 0);
            if (wait == WAIT_FAILED) return false;
            if (wait == WAIT_OBJECT_0 && out_eof && err_eof) return !output.empty();
            Sleep(10);
        }
        return false;
    }
    bool exited() {
        DWORD code = STILL_ACTIVE;
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
        return WaitForSingleObject(process.value, 0) == WAIT_OBJECT_0 && GetExitCodeProcess(process.value, &code) && code == 0 &&
            QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) && accounting.ActiveProcesses == 0;
    }
public:
    explicit Win32Backend(NativeConfig value) : config(std::move(value)) {}
    ~Win32Backend() override { cleanup(); }
    Kind kind() const noexcept override { return Kind::Win32; }
    std::string_view receipt() const noexcept override { return output; }
    bool perform(Step step) override {
        switch (step) {
        case Step::Preflight: return preflight();
        case Step::Job: return create_job();
        case Step::Pipes: return pipe(in_read, in_write, false) && pipe(out_read, out_write, true) && pipe(err_read, err_write, true);
        case Step::Attributes: return build_attributes();
        case Step::Suspended: return create_suspended();
        case Step::Identity: return identity();
        case Step::Resume: return GetTickCount64() - started < 10000 && ResumeThread(thread.value) == 1;
        case Step::Exchange: return exchange();
        case Step::Exit: return exited();
        default: return false;
        }
    }
    bool cleanup() noexcept override {
        bool terminated = true;
        in_write.reset();
        if (process.valid() && WaitForSingleObject(process.value, 0) != WAIT_OBJECT_0) {
            if (job.valid()) TerminateJobObject(job.value, ERROR_CANCELLED);
            if (WaitForSingleObject(process.value, 2000) != WAIT_OBJECT_0) {
                // Exact owned child only; not a weaker execution fallback or process-name search.
                TerminateProcess(process.value, ERROR_CANCELLED);
                terminated = WaitForSingleObject(process.value, 2000) == WAIT_OBJECT_0;
            }
        }
        if (job.valid()) {
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting{};
            if (!QueryInformationJobObject(job.value, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), nullptr) || accounting.ActiveProcesses) terminated = false;
        }
        thread.reset(); process.reset(); job.reset();
        in_read.reset(); out_read.reset(); out_write.reset(); err_read.reset(); err_write.reset();
        if (attributes) { DeleteProcThreadAttributeList(attributes); attributes = nullptr; }
        if (sid) { LocalFree(sid); sid = nullptr; }
        executable.reset(); directories.clear();
        return terminated;
    }
};
}
std::unique_ptr<Backend> make_win32_backend(NativeConfig config) { return std::make_unique<Win32Backend>(std::move(config)); }
} // namespace isolation
