#pragma once
#include "file-probe-common.hpp"
#include <sddl.h>
#include <userenv.h>
#include <algorithm>
#include <stdexcept>

namespace provision {
struct Local { void* value=nullptr; ~Local(){ if(value) LocalFree(value); } Local()=default; Local(const Local&)=delete; Local& operator=(const Local&)=delete; };
struct Sid { PSID value=nullptr; ~Sid(){ if(value) FreeSid(value); } };
constexpr std::array<const char*,5> kinds{"HOST","TRAVERSE","READ","EXECUTE","APPEND"};
constexpr std::array<DWORD,5> masks{0,0x001200a9,0x00120089,0x001200a9,0x00100084};
inline void require(bool value){ if(!value) throw std::runtime_error("PROVISION_INVALID"); }
inline std::wstring sddl(size_t kind,const std::wstring& host,const std::wstring& app){
    require(kind<kinds.size());
    constexpr std::array<const wchar_t*,5> text{L"",L"0x001200a9",L"0x00120089",L"0x001200a9",L"0x00100084"};
    return L"O:"+host+L"D:P(A;;0x001f01ff;;;S-1-5-18)(A;;0x001f01ff;;;"+host+L")"+
        (kind?L"(A;;"+std::wstring(text[kind])+L";;;"+app+L")":L"")+L"S:P(ML;;NW;;;"+(kind==4?L"LW":L"ME")+L")";
}
inline bool equal_text_sid(PSID sid,const std::wstring& expected){
    Local converted; return sid && IsValidSid(sid) && ConvertStringSidToSidW(expected.c_str(),&converted.value) && EqualSid(sid,converted.value);
}
inline bool verify(PSECURITY_DESCRIPTOR sd,size_t kind,const std::wstring& host,const std::wstring& app){
    if(kind>=kinds.size() || !sd || !IsValidSecurityDescriptor(sd)) return false;
    SECURITY_DESCRIPTOR_CONTROL control=0; DWORD revision=0;
    const WORD required=SE_DACL_PRESENT|SE_DACL_PROTECTED|SE_SACL_PRESENT|SE_SACL_PROTECTED|SE_SELF_RELATIVE;
    if(!GetSecurityDescriptorControl(sd,&control,&revision) || control!=required || revision!=SECURITY_DESCRIPTOR_REVISION) return false;
    PSID owner=nullptr; BOOL def=FALSE;
    if(!GetSecurityDescriptorOwner(sd,&owner,&def) || def || !equal_text_sid(owner,host)) return false;
    PSID group=nullptr; if(!GetSecurityDescriptorGroup(sd,&group,&def) || group) return false;
    PACL dacl=nullptr,sacl=nullptr; BOOL present=FALSE;
    if(!GetSecurityDescriptorDacl(sd,&present,&dacl,&def) || !present || def || !dacl || !IsValidAcl(dacl) || dacl->AceCount!=(kind?3:2)) return false;
    for(DWORD i=0;i<dacl->AceCount;++i){
        void* raw=nullptr; if(!GetAce(dacl,i,&raw)) return false;
        auto* ace=static_cast<ACCESS_ALLOWED_ACE*>(raw);
        if(ace->Header.AceType!=ACCESS_ALLOWED_ACE_TYPE || ace->Header.AceFlags || ace->Mask!=(i==2?masks[kind]:FILE_ALL_ACCESS) ||
            !equal_text_sid(&ace->SidStart,i==0?L"S-1-5-18":i==1?host:app)) return false;
    }
    if(!GetSecurityDescriptorSacl(sd,&present,&sacl,&def) || !present || def || !sacl || !IsValidAcl(sacl) || sacl->AceCount!=1) return false;
    void* raw=nullptr; if(!GetAce(sacl,0,&raw)) return false;
    auto* label=static_cast<SYSTEM_MANDATORY_LABEL_ACE*>(raw);
    return label->Header.AceType==SYSTEM_MANDATORY_LABEL_ACE_TYPE && !label->Header.AceFlags && label->Mask==SYSTEM_MANDATORY_LABEL_NO_WRITE_UP &&
        equal_text_sid(&label->SidStart,kind==4?L"S-1-16-4096":L"S-1-16-8192");
}
inline bool check_text(const std::wstring& text,size_t kind,const std::wstring& host,const std::wstring& app){
    Local sd; ULONG size=0;
    return ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),SDDL_REVISION_1,&sd.value,&size) && size<=4096 && verify(sd.value,kind,host,app);
}
inline std::wstring sid_text(PSID sid){
    Local text; require(sid && IsValidSid(sid) && ConvertSidToStringSidW(sid,reinterpret_cast<LPWSTR*>(&text.value)));
    return static_cast<const wchar_t*>(text.value);
}
inline std::wstring host_sid(){
    HANDLE raw=nullptr; require(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&raw)!=FALSE); file_probe::Handle token(raw);
    DWORD size=0; GetTokenInformation(token.value,TokenUser,nullptr,0,&size); require(size>=sizeof(TOKEN_USER)&&size<=4096);
    std::vector<std::byte> bytes(size); require(GetTokenInformation(token.value,TokenUser,bytes.data(),size,&size)!=FALSE);
    const auto text=sid_text(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid);
    require(text.starts_with(L"S-1-5-21-")); return text;
}
inline std::wstring app_sid(std::string id){
    require(analysis_validator::uuid(id)); id.erase(std::remove(id.begin(),id.end(),'-'),id.end()); Sid sid;
    require(SUCCEEDED(DeriveAppContainerSidFromAppContainerName((L"PaperLab.Analysis.Offline.v1."+file_probe::widen(id)).c_str(),&sid.value)));
    const auto text=sid_text(sid.value); require(text.starts_with(L"S-1-15-2-")); return text;
}
inline std::string ascii(const std::wstring& value){
    std::string text; for(wchar_t c:value){require(c>0&&c<128);text.push_back(static_cast<char>(c));} return text;
}
} // namespace provision
