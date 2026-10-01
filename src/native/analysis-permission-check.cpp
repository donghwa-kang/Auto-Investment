#include "permission-mutation.hpp"
#include <iostream>
using namespace permission_mutation;
namespace {
struct Model final : Port {
    int stage=0, fail=0, changes=0, wrong_id_at=0, wrong_security_at=0; bool throws=false;
    Kind kind() const noexcept override { return Kind::Model; }
    bool pass() { ++stage; if(stage==fail) { if(throws) throw 1; return false; } return true; }
    bool observe(const Intent& i,bool desired,Snapshot& s) override {
        if(!pass()) return false;
        s={stage==wrong_id_at?std::string(64,'0'):i.object_id,stage==wrong_security_at?std::string(64,'0'):security_hash(i,desired)};
        return true;
    }
    bool change(const Intent&) override { ++changes; return pass(); }
};
struct MemoryJournal final : JournalPort {
    bool before_ok=true,after_ok=true,bad_ack=false; int before_calls=0,after_calls=0;
    bool before(const Intent& i,std::string& ack) override { ++before_calls; ack=bad_ack?std::string(64,'0'):intent_hash(i); return before_ok; }
    bool after(const Intent&,bool) override { ++after_calls; return after_ok; }
};
int self_test() {
    const std::string id="5dd10c89-7dba-44d2-a793-fa09d92c5e66";
    Intent i{id,id,std::string(64,'a'),std::string(64,'b'),L"C:\\PaperLab\\work\\analysis-os-lab\\run-"+file_probe::widen(id),
        L"S-1-5-21-111-222-333-1001",L"S-1-15-2-1-2-3-4-5-6-7",0,false};
    int checks=0;
    const auto check=[&checks](bool ok){ provision::require(ok); ++checks; };
    for(size_t target_index=0;target_index<16;++target_index) for(bool restore:{false,true}) {
        i.target=target_index; i.restore=restore; Model port; MemoryJournal journal;
        check(run(port,journal,i)==Result::VerifiedModel && port.changes==1 && journal.before_calls==1 && journal.after_calls==1);
    }
    for(int fail=1;fail<=3;++fail) for(bool throws:{false,true}) {
        Model port; port.fail=fail; port.throws=throws; MemoryJournal journal;
        check(run(port,journal,i)!=Result::VerifiedModel && port.changes<2);
    }
    { Model p; MemoryJournal j; j.before_ok=false; check(run(p,j,i)==Result::JournalHold && !p.changes); }
    { Model p; MemoryJournal j; j.bad_ack=true; check(run(p,j,i)==Result::JournalHold && !p.changes); }
    { Model p; MemoryJournal j; j.after_ok=false; check(run(p,j,i)==Result::JournalHold && p.changes==1); }
    { Model p; MemoryJournal j; auto bad=i; bad.target=16; check(run(p,j,bad)==Result::Invalid && !p.changes); }
    { Model p; MemoryJournal j; auto bad=i; bad.root=L"C:\\Users"; check(run(p,j,bad)==Result::Invalid && !p.changes); }
    { Model p; MemoryJournal j; auto bad=i; bad.plan_sha256=""; check(run(p,j,bad)==Result::Invalid && !p.changes); }
    for(int at:{1,3}) {
        { Model p; MemoryJournal j; p.wrong_id_at=at; check(run(p,j,i)==(at==1?Result::PreconditionHold:Result::Uncertain)); }
        { Model p; MemoryJournal j; p.wrong_security_at=at; check(run(p,j,i)==(at==1?Result::PreconditionHold:Result::Uncertain)); }
    }
    // Construction only: the public controller rejects the real port before observation or mutation.
    { auto p=make_win32_port(); MemoryJournal j; check(run(*p,j,i)==Result::Locked && !j.before_calls && !j.after_calls); }
    std::cout<<"{\"status\":\"PERMISSION_MODEL_CHECKED_WIN32_LOCKED\",\"checks\":"<<checks
        <<",\"osChangesApplied\":false,\"osRecoveryVerified\":false}\n";
    return 0;
}
}
int wmain(int argc,wchar_t** argv) {
    if(argc!=2 || std::wstring_view(argv[1])!=L"--self-test") return 2;
    try { return self_test(); } catch(...) { return 6; }
}
