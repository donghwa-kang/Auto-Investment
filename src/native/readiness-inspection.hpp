#pragma once
#include "permission-mutation.hpp"
#include <aclapi.h>
#include <objbase.h>
#include <sstream>

namespace readiness {
using provision::require;
using file_probe::Handle;
inline std::string hex(std::string_view bytes){
    std::string out;out.reserve(bytes.size()*2);
    for(unsigned char c:bytes){out+="0123456789abcdef"[c>>4];out+="0123456789abcdef"[c&15];}
    return out;
}
inline std::wstring cwd(){std::array<wchar_t,512>b{};DWORD n=GetCurrentDirectoryW(static_cast<DWORD>(b.size()),b.data());require(n&&n<b.size()&&file_probe::plain_local_path(b.data()));return b.data();}
inline std::string id(HANDLE h){FILE_ID_INFO f{};require(GetFileInformationByHandleEx(h,FileIdInfo,&f,sizeof(f))!=FALSE);return file_probe::sha256({reinterpret_cast<char*>(&f),sizeof(f)});}
inline std::string node_id(HANDLE h){BY_HANDLE_FILE_INFORMATION f{};require(GetFileInformationByHandle(h,&f)!=FALSE);return file_probe::sha256(std::to_string(f.dwVolumeSerialNumber)+"\n"+std::to_string((static_cast<ULONGLONG>(f.nFileIndexHigh)<<32)|f.nFileIndexLow)+"\n");}
inline std::vector<std::string> fields(const std::string& wire){
    std::istringstream input(wire);std::vector<std::string> out;std::string part,canonical;
    while(input>>part){out.push_back(part);if(!canonical.empty())canonical+=' ';canonical+=part;}
    require(canonical+"\n"==wire);return out;
}
struct Request {std::string lab,run,owner,node_root,nonce,wire;};
inline Request parse(const std::string& wire){
    const auto f=fields(wire);require(f.size()==6&&f[0]=="READINESS_INSPECT_V1"&&analysis_validator::uuid(f[1])&&
        analysis_validator::uuid(f[2])&&analysis_validator::hash(f[3])&&analysis_validator::hash(f[4])&&analysis_validator::uuid(f[5]));
    return{f[1],f[2],f[3],f[4],f[5],wire};
}
struct Descriptor {std::string bytes,sha;DWORD control=0;std::string dacl;DWORD aces=0;};
inline Descriptor descriptor(HANDLE h,SECURITY_INFORMATION flags,const std::wstring& host){
    provision::Local sd;PSID owner=nullptr;PACL dacl=nullptr;
    require(GetSecurityInfo(h,SE_FILE_OBJECT,flags,&owner,nullptr,&dacl,nullptr,reinterpret_cast<PSECURITY_DESCRIPTOR*>(&sd.value))==ERROR_SUCCESS);
    require(sd.value&&IsValidSecurityDescriptor(sd.value)&&provision::equal_text_sid(owner,host));
    const DWORD length=GetSecurityDescriptorLength(sd.value);require(length>=20&&length<=4096);
    SECURITY_DESCRIPTOR_CONTROL control=0;DWORD revision=0;require(GetSecurityDescriptorControl(sd.value,&control,&revision)!=FALSE&&revision==SECURITY_DESCRIPTOR_REVISION&&(control&SE_SELF_RELATIVE));
    BOOL present=FALSE,def=FALSE;require(GetSecurityDescriptorDacl(sd.value,&present,&dacl,&def)!=FALSE);
    Descriptor value;value.bytes.assign(static_cast<char*>(sd.value),length);value.sha=file_probe::sha256(value.bytes);value.control=control;
    value.dacl=!present?"ABSENT":!dacl?"NULL":!dacl->AceCount?"EMPTY":"ACL";
    if(dacl){require(IsValidAcl(dacl)!=FALSE);value.aces=dacl->AceCount;}
    return value;
}
inline std::string descriptor_json(const Descriptor& d){return "{\"sha256\":\""+d.sha+"\",\"hex\":\""+hex(d.bytes)+"\",\"control\":"+std::to_string(d.control)+",\"dacl\":\""+d.dacl+"\",\"aceCount\":"+std::to_string(d.aces)+"}";}
struct Fixture {
    std::wstring root,host;std::string lab;
    std::vector<Handle> ancestors;std::array<Handle,16> objects;std::array<std::string,16> ids;
    std::wstring path(size_t i)const{return root+(i?L"\\"+std::wstring(permission_mutation::paths[i]):L"");}
    void open(const Request&r){
        host=provision::host_sid();require(file_probe::sha256(provision::ascii(host))==r.owner);
        lab=r.lab;root=cwd()+L"\\work\\analysis-permission-bridge-lab\\lab-"+file_probe::widen(lab)+L"\\fixture";
        require(file_probe::plain_local_path(root));
        for(size_t end=3;end<root.size();++end)if(root[end]==L'\\'){
            const auto p=root.substr(0,end);Handle h(CreateFileW(p.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(h.valid()&&file_probe::same_file(h.value,p,true));ancestors.push_back(std::move(h));
        }
        for(size_t i=0;i<16;++i){
            objects[i]=Handle(CreateFileW(path(i).c_str(),READ_CONTROL|FILE_READ_ATTRIBUTES|(i>=7?FILE_READ_DATA:0),
                i<7?FILE_SHARE_READ|FILE_SHARE_WRITE:FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(objects[i].valid()&&file_probe::same_file(objects[i].value,path(i),i<7));ids[i]=id(objects[i].value);
            if(i>=7){std::string bytes;require(file_probe::read_small(objects[i].value,bytes,128)&&bytes=="BRIDGE_DUMMY_V1\n"+lab+"\n"+std::to_string(i)+"\n");}
        }
        require(node_id(objects[0].value)==r.node_root);
    }
};
inline std::string profile(const Request&r){
    const auto sid=provision::app_sid(r.run);PWSTR raw=nullptr;
    const HRESULT result=GetAppContainerFolderPath(sid.c_str(),&raw);
    struct Free {PWSTR value;~Free(){if(value)CoTaskMemFree(value);}} path{raw};
    std::string state="UNKNOWN",path_hash="null";DWORD error=0;
    if(SUCCEEDED(result)&&raw){
        const std::wstring value(raw);require(value.size()<=32767);
        path_hash="\""+file_probe::sha256({reinterpret_cast<const char*>(value.data()),value.size()*sizeof(wchar_t)})+"\"";
        const DWORD attr=GetFileAttributesW(raw);
        if(attr==INVALID_FILE_ATTRIBUTES){error=GetLastError();if(error==ERROR_FILE_NOT_FOUND||error==ERROR_PATH_NOT_FOUND)state="PATH_ABSENT";}
        else state=(attr&FILE_ATTRIBUTE_REPARSE_POINT)?"REPARSE_HOLD":(attr&FILE_ATTRIBUTE_DIRECTORY)?"PATH_PRESENT":"TYPE_HOLD";
    }
    return "{\"appSidSha256\":\""+file_probe::sha256(provision::ascii(sid))+"\",\"folder\":\""+state+"\",\"hresult\":"+std::to_string(static_cast<ULONG>(result))+",\"win32Error\":"+std::to_string(error)+",\"pathSha256\":"+path_hash+",\"registration\":\"NOT_VERIFIED\",\"ownership\":\"NOT_PROVEN\",\"creationReceipt\":null}";
}
inline std::string inspect(const Request&r){
    Fixture fixture;fixture.open(r);std::string records="[";
    constexpr SECURITY_INFORMATION base_flags=OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|DACL_SECURITY_INFORMATION|LABEL_SECURITY_INFORMATION;
    for(size_t i=0;i<16;++i){
        const auto base=descriptor(fixture.objects[i].value,base_flags,fixture.host);
        Handle full(CreateFileW(fixture.path(i).c_str(),READ_CONTROL|ACCESS_SYSTEM_SECURITY|FILE_READ_ATTRIBUTES,
            i<7?FILE_SHARE_READ|FILE_SHARE_WRITE:FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        DWORD error=full.valid()?0:GetLastError();std::string full_json="null",matches="null";
        if(full.valid()){
            require(file_probe::same_file(full.value,fixture.path(i),i<7)&&id(full.value)==fixture.ids[i]);
            const auto observed=descriptor(full.value,base_flags|SACL_SECURITY_INFORMATION,fixture.host);full_json=descriptor_json(observed);
            matches=provision::verify(const_cast<char*>(observed.bytes.data()),0,fixture.host,provision::app_sid(r.run))?"true":"false";
        }
        require(descriptor(fixture.objects[i].value,base_flags,fixture.host).sha==base.sha&&id(fixture.objects[i].value)==fixture.ids[i]);
        if(i)records+=',';
        records+="{\"index\":"+std::to_string(i)+",\"nodeId\":\""+node_id(fixture.objects[i].value)+"\",\"objectId\":\""+fixture.ids[i]+"\",\"base\":"+descriptor_json(base)+",\"saclError\":"+std::to_string(error)+",\"withSacl\":"+full_json+",\"matchesPlannedInitial\":"+matches+"}";
    }
    records+=']';
    return "{\"version\":\"READINESS_OBSERVATION_V1\",\"requestSha256\":\""+file_probe::sha256(r.wire)+"\",\"nonce\":\""+r.nonce+"\",\"ownerSha256\":\""+r.owner+"\",\"baseScope\":\"OWNER_GROUP_DACL_LABEL\",\"additionalScope\":\"SACL\",\"files\":"+records+",\"profile\":"+profile(r)+",\"osChangesApplied\":false}\n";
}
} // namespace readiness
