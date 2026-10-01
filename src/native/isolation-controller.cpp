#include "isolation-win32.hpp"
#include <stdexcept>

namespace {
struct Model final : isolation::Backend {
    int failure = -1;
    bool throw_failure = false, cleanup_failure = false;
    bool job = false, pipes = false, attributes = false, process = false, resumed = false, identity_verified = false;
    size_t calls = 0, cleanups = 0;
    isolation::Kind type = isolation::Kind::Model;
    isolation::Kind kind() const noexcept override { return type; }
    std::string_view receipt() const noexcept override { return {}; }
    bool perform(isolation::Step step) override {
        if (static_cast<size_t>(step) != calls++) throw std::logic_error("ORDER");
        switch (step) {
        case isolation::Step::Job: job = true; break;
        case isolation::Step::Pipes: pipes = true; break;
        case isolation::Step::Attributes: attributes = true; break;
        case isolation::Step::Suspended: if (!job || !pipes || !attributes) throw std::logic_error("CREATE_ORDER"); process = true; break;
        case isolation::Step::Identity: identity_verified = true; break;
        case isolation::Step::Resume: if (!process || !identity_verified) throw std::logic_error("UNVERIFIED_RESUME"); resumed = true; break;
        default: break;
        }
        if (static_cast<int>(step) == failure) { if (throw_failure) throw std::runtime_error("INJECTED"); return false; }
        return true;
    }
    bool cleanup() noexcept override { ++cleanups; job = pipes = attributes = process = false; return !cleanup_failure; }
};
void require(bool condition) { if (!condition) throw std::logic_error("MODEL_ASSERTION"); }
size_t exercise() {
    size_t checks = 0;
    Model normal; auto success = isolation::run(normal, true);
    require(success.passed && success.cleanup_verified && normal.calls == 9 && normal.cleanups == 1 && normal.resumed && !normal.process); ++checks;
    for (int failure = 0; failure < 9; ++failure) for (bool throws : {false, true}) {
        Model model; model.failure = failure; model.throw_failure = throws;
        const auto result = isolation::run(model, true);
        require(!result.passed && result.cleanup_verified && static_cast<int>(result.failed_at) == failure &&
            model.calls == static_cast<size_t>(failure + 1) && model.cleanups == 1 && !model.job && !model.pipes && !model.attributes && !model.process);
        if (failure < 6) require(!model.resumed);
        ++checks;
    }
    Model failed_cleanup; failed_cleanup.cleanup_failure = true;
    require(!isolation::run(failed_cleanup, true).passed); ++checks;
    Model unapproved; require(isolation::run(unapproved, false).locked && !unapproved.calls && !unapproved.cleanups); ++checks;
    Model impersonated; impersonated.type = isolation::Kind::Win32;
    require(isolation::run(impersonated, true).locked && !impersonated.calls && !impersonated.cleanups); ++checks;
    // Instantiate the linked Win32 adapter but never perform an OS step.
    auto native = isolation::make_win32_backend({});
    const auto locked = isolation::run(*native, true);
    require(locked.locked && !locked.calls && !locked.passed); ++checks;
    return checks;
}
}
int wmain(int argc, wchar_t** argv) {
    if (argc != 2 || std::wcscmp(argv[1], L"--self-test") != 0) return 2;
    try {
        const auto checks = exercise();
        return file_probe::write_pipe("{\"status\":\"LIFECYCLE_MODEL_TESTS_PASSED\",\"checks\":" + std::to_string(checks) +
            ",\"backend\":\"MODEL\",\"win32StepsExecuted\":0,\"executionAllowed\":false,\"osIsolationVerified\":false}\n") ? 0 : 5;
    } catch (...) { return 1; }
}
