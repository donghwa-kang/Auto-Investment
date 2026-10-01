#pragma once
#include "provision-security.hpp"
#include <memory>

namespace permission_mutation {
constexpr std::array<const wchar_t*,16> paths{L"",L"bin",L"input",L"private",L"scratch",L"profile",L"evidence",
    L"fixture-marker.txt",L"manifest.json",L"bin\\analysis-file-probe.exe",L"input\\allow.txt",L"scratch\\write.txt",
    L"private\\read.txt",L"private\\append.txt",L"private\\delete.txt",L"private\\rename.txt"};
constexpr std::array<size_t,16> target_kinds{1,1,1,0,1,0,0,2,0,3,2,4,0,0,0,0};
struct Intent {
    std::string run_id, operation_id, plan_sha256, object_id;
    std::wstring root, host_sid, app_sid;
    size_t target=0; bool restore=false;
};
inline bool valid(const Intent& i) {
    return analysis_validator::uuid(i.run_id) && analysis_validator::uuid(i.operation_id) &&
        analysis_validator::hash(i.plan_sha256) && analysis_validator::hash(i.object_id) && i.target<paths.size() &&
        file_probe::plain_local_path(i.root) && i.root.ends_with(L"\\work\\analysis-os-lab\\run-"+file_probe::widen(i.run_id)) &&
        provision::check_text(provision::sddl(0,i.host_sid,i.app_sid),0,i.host_sid,i.app_sid) &&
        provision::check_text(provision::sddl(target_kinds[i.target],i.host_sid,i.app_sid),target_kinds[i.target],i.host_sid,i.app_sid);
}
inline std::string security_hash(const Intent& i,bool desired) {
    const size_t kind=(desired!=i.restore)?target_kinds[i.target]:0;
    return file_probe::sha256(provision::ascii(provision::sddl(kind,i.host_sid,i.app_sid)));
}
inline std::string intent_hash(const Intent& i) {
    // root is UTF-16 bytes: this native ABI is not the TypeScript JSON ABI.
    const std::string root(reinterpret_cast<const char*>(i.root.data()),i.root.size()*sizeof(wchar_t));
    return file_probe::sha256(i.run_id+"\n"+i.operation_id+"\n"+i.plan_sha256+"\n"+i.object_id+"\n"+
        file_probe::sha256(root)+"\n"+std::to_string(i.target)+"\n"+(i.restore?"RESTORE":"APPLY")+"\n"+
        security_hash(i,false)+"\n"+security_hash(i,true)+"\n");
}
struct Snapshot { std::string object_id, security_sha256; };
enum class Kind { Model, Win32 };
struct Port {
    virtual ~Port()=default;
    virtual Kind kind() const noexcept=0;
    virtual bool observe(const Intent&,bool desired,Snapshot&)=0;
    virtual bool change(const Intent&)=0;
};
struct JournalPort {
    virtual ~JournalPort()=default;
    virtual bool before(const Intent&,std::string& durable_intent_hash)=0;
    virtual bool after(const Intent&,bool verified)=0;
};
enum class Result { Locked, Invalid, PreconditionHold, JournalHold, Uncertain, VerifiedModel };
inline Result run(Port& port,JournalPort& journal,const Intent& i) {
    if(port.kind()!=Kind::Model) return Result::Locked; // No argv, environment or receipt can unlock Win32.
    bool recorded=false;
    try {
        if(!valid(i)) return Result::Invalid;
        Snapshot before;
        if(!port.observe(i,false,before) || before.object_id!=i.object_id || before.security_sha256!=security_hash(i,false)) return Result::PreconditionHold;
        std::string ack;
        if(!journal.before(i,ack) || ack!=intent_hash(i)) return Result::JournalHold;
        recorded=true;
        if(!port.change(i)) { journal.after(i,false); return Result::Uncertain; }
        Snapshot after;
        const bool verified=port.observe(i,true,after) && after.object_id==i.object_id && after.security_sha256==security_hash(i,true);
        if(!journal.after(i,verified)) return Result::JournalHold;
        return verified?Result::VerifiedModel:Result::Uncertain;
    } catch(...) {
        // Never retry a mutation; preserve an uncertain durable intent for independent review.
        if(recorded) { try { journal.after(i,false); } catch(...) {} }
        return recorded?Result::Uncertain:Result::PreconditionHold;
    }
}
std::unique_ptr<Port> make_win32_port();
} // namespace permission_mutation
