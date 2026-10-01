#include "provision-security.hpp"

namespace {
std::string inspection(const std::string& id,const std::string& request){
    const auto host=provision::host_sid(), app=provision::app_sid(id);
    std::string output="{\"version\":\"PROVISION_INSPECTION_V1\",\"runId\":\""+id+"\",\"requestSha256\":\""+file_probe::sha256(request)+"\",\"hostSid\":\""+provision::ascii(host)+"\",\"appSid\":\""+provision::ascii(app)+"\",\"descriptors\":[";
    for(size_t i=0;i<provision::kinds.size();++i){
        const auto text=provision::sddl(i,host,app); provision::Local sd; ULONG size=0;
        provision::require(ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),SDDL_REVISION_1,&sd.value,&size)&&size<=4096&&provision::verify(sd.value,i,host,app));
        provision::Local roundtrip;
        provision::require(ConvertSecurityDescriptorToStringSecurityDescriptorW(sd.value,SDDL_REVISION_1,OWNER_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION,reinterpret_cast<LPWSTR*>(&roundtrip.value),nullptr)!=FALSE);
        provision::require(provision::check_text(static_cast<const wchar_t*>(roundtrip.value),i,host,app));
        if(i)output+=",";
        output+="{\"kind\":\""+std::string(provision::kinds[i])+"\",\"sddlSha256\":\""+file_probe::sha256(provision::ascii(text))+"\",\"descriptorSha256\":\""+file_probe::sha256(std::string_view(static_cast<const char*>(sd.value),size))+"\",\"bytes\":"+std::to_string(size)+"}";
    }
    return output+"],\"memoryStructureVerified\":true,\"profileExistence\":\"NOT_QUERIED\",\"osChangesApplied\":false,\"osIsolationVerified\":false}\n";
}
size_t self_test(){
    const std::wstring host=L"S-1-5-21-111-222-333-1001", app=L"S-1-15-2-1-2-3-4-5-6-7";
    size_t checks=0;
    for(size_t i=0;i<provision::kinds.size();++i){
        const auto valid=provision::sddl(i,host,app);
        provision::require(provision::check_text(valid,i,host,app)); ++checks;
        std::vector<std::wstring> bad;
        auto no_protect=valid; no_protect.replace(no_protect.find(L"D:P"),3,L"D:"); bad.push_back(no_protect);
        auto inherited=valid; inherited.replace(inherited.find(L"(A;;"),4,L"(A;OI;"); bad.push_back(inherited);
        auto broad=valid; broad.insert(broad.find(L"S:P"),L"(A;;FA;;;WD)"); bad.push_back(broad);
        auto owner=valid; owner.replace(2,host.size(),L"S-1-5-18"); bad.push_back(owner);
        auto label=valid; label.replace(label.find(L"NW"),2,L"NR"); bad.push_back(label);
        auto null_acl=valid.substr(0,valid.find(L"D:P"))+L"D:NO_ACCESS_CONTROLS:P(ML;;NW;;;ME)"; bad.push_back(null_acl);
        auto no_label=valid.substr(0,valid.find(L"S:P")); bad.push_back(no_label);
        auto wrong_label=valid; const auto pos=wrong_label.rfind(i==4?L"LW":L"ME"); wrong_label.replace(pos,2,i==4?L"ME":L"LW"); bad.push_back(wrong_label);
        for(const auto& value:bad){provision::require(!provision::check_text(value,i,host,app));++checks;}
        if(i){auto full=valid;const auto second=full.find(L"(A;;",full.find(L"(A;;")+1); const auto third=full.find(L"(A;;",second+1); full.replace(third+4,10,L"0x001f01ff");provision::require(!provision::check_text(full,i,host,app));++checks;}
    }
    return checks;
}
}
int wmain(int argc,wchar_t** argv){
    if(argc!=2 || (std::wstring_view(argv[1])!=L"--inspect" && std::wstring_view(argv[1])!=L"--self-test"))return 2;
    if(GetFileType(GetStdHandle(STD_OUTPUT_HANDLE))!=FILE_TYPE_PIPE)return 3;
    try{
        if(std::wstring_view(argv[1])==L"--self-test")return file_probe::write_pipe("{\"status\":\"SECURITY_MEMORY_TESTS_PASSED\",\"checks\":"+std::to_string(self_test())+",\"osChangesApplied\":false,\"osIsolationVerified\":false}\n")?0:5;
        std::string request; if(!file_probe::read_pipe(request))return 3;
        constexpr std::string_view prefix="PROVISION_INSPECT_V1\n", suffix="\nEND\n";
        if(request.size()!=prefix.size()+36+suffix.size() || !request.starts_with(prefix)||!request.ends_with(suffix))return 3;
        const auto id=request.substr(prefix.size(),36);if(!analysis_validator::uuid(id))return 3;
        const auto output=inspection(id,request);
        return file_probe::write_pipe(output)?0:5;
    }catch(...){return 6;}
}
