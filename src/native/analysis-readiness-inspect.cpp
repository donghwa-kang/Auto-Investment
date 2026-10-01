#include "readiness-process.hpp"

namespace {
void output(const std::string& value){for(size_t p=0;p<value.size();p+=8192)readiness::require(file_probe::write_pipe(value.substr(p,8192)));}
int child(){std::string wire;readiness::require(file_probe::read_pipe(wire));output(readiness::inspect(readiness::parse(wire)));return 0;}
int inspect(){
    std::string wire;readiness::require(file_probe::read_pipe(wire));readiness::parse(wire);
    const auto result=readiness::supervise(L"--read-only-child",wire,10000);
    if(!result.signaled||result.forced||result.code!=0){
        output("{\"version\":\"READINESS_CHILD_HOLD_V1\",\"process\":"+readiness::process_json(result)+",\"executionAllowed\":false}\n");return 2;
    }
    readiness::require(!result.payload.empty()&&result.payload.back()=='\n');
    output("{\"version\":\"READINESS_SUPERVISED_V1\",\"observation\":"+result.payload.substr(0,result.payload.size()-1)+",\"process\":"+readiness::process_json(result)+",\"executionAllowed\":false}\n");return 0;
}
int self_test(){
    const auto normal=readiness::supervise(L"--exit-normal-child","",2000);
    const auto failed=readiness::supervise(L"--exit-nonzero-child","",2000);
    const auto claim=readiness::supervise(L"--exit-claim-child","",1000);
    readiness::require(normal.signaled&&!normal.forced&&normal.code==0&&failed.signaled&&!failed.forced&&failed.code==7&&claim.signaled&&claim.forced&&claim.code==124&&claim.payload=="CLAIM_EXIT\n");
    output("{\"status\":\"OWNED_CHILD_TERMINATION_CHECKED\",\"normal\":"+readiness::process_json(normal)+",\"nonzero\":"+readiness::process_json(failed)+",\"earlyClaim\":"+readiness::process_json(claim)+",\"osChangesApplied\":false}\n");return 0;
}
}
int wmain(int argc,wchar_t**argv){
    if(argc!=2)return 2;
    try{
        const std::wstring_view action=argv[1];
        if(action==L"--stdio-inspect")return inspect();
        if(action==L"--read-only-child")return child();
        if(action==L"--process-self-test")return self_test();
        if(action==L"--exit-normal-child")return 0;
        if(action==L"--exit-nonzero-child")return 7;
        if(action==L"--exit-claim-child"){output("CLAIM_EXIT\n");Sleep(10000);return 0;}
    }catch(...){return 2;}
    return 2;
}
