#include "permission-mutation.hpp"
#include <aclapi.h>

namespace permission_mutation {
namespace {
using file_probe::Handle;
class Win32Port final : public Port {
    std::vector<Handle> ancestors;
    Handle target;
    std::string pinned_intent;
    std::wstring target_path;
    bool change_attempted=false;
    bool pin_directory(const std::wstring& path) {
        Handle h(CreateFileW(path.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        if(!h.valid() || !file_probe::same_file(h.value,path,true)) return false;
        ancestors.push_back(std::move(h)); return true;
    }
    bool pin(const Intent& i) {
        if(!valid(i) || provision::host_sid()!=i.host_sid || provision::app_sid(i.run_id)!=i.app_sid) return false;
        if(target.valid()) return pinned_intent==intent_hash(i);
        target_path=i.root+(i.target?L"\\"+std::wstring(paths[i.target]):L"");
        if(!file_probe::plain_local_path(target_path)) return false;
        // Pin all ancestors without delete sharing; never create or follow a reparse point.
        if(!pin_directory(i.root.substr(0,3))) return false;
        for(size_t end=3;end<target_path.size();++end)
            if(target_path[end]==L'\\' && !pin_directory(target_path.substr(0,end))) return false;
        // Full SACL reading/protection requires an already enabled SeSecurityPrivilege.
        // Do not enable privileges, request elevation, or silently drop SACL protection.
        target=Handle(CreateFileW(target_path.c_str(),READ_CONTROL|WRITE_DAC|ACCESS_SYSTEM_SECURITY|FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
        if(!target.valid() || !file_probe::same_file(target.value,target_path,i.target<7)) return false;
        pinned_intent=intent_hash(i); return true;
    }
    bool snapshot(const Intent& i,bool desired,Snapshot& result) {
        if(!pin(i) || !file_probe::same_file(target.value,target_path,i.target<7)) return false;
        FILE_ID_INFO identity{};
        if(!GetFileInformationByHandleEx(target.value,FileIdInfo,&identity,sizeof(identity))) return false;
        const auto id=file_probe::sha256(std::string_view(reinterpret_cast<const char*>(&identity),sizeof(identity)));
        if(id!=i.object_id) return false;
        provision::Local descriptor;
        const DWORD error=GetSecurityInfo(target.value,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION|GROUP_SECURITY_INFORMATION|
            DACL_SECURITY_INFORMATION|SACL_SECURITY_INFORMATION,nullptr,nullptr,nullptr,nullptr,&descriptor.value);
        if(error!=ERROR_SUCCESS) return false;
        const size_t kind=(desired!=i.restore)?target_kinds[i.target]:0;
        if(!provision::verify(descriptor.value,kind,i.host_sid,i.app_sid)) return false;
        result={id,security_hash(i,desired)}; return true;
    }
public:
    Kind kind() const noexcept override { return Kind::Win32; }
    bool observe(const Intent& i,bool desired,Snapshot& result) override { return snapshot(i,desired,result); }
    bool change(const Intent& i) override {
        if(change_attempted) return false;
        change_attempted=true;
        Snapshot current;
        if(!snapshot(i,false,current)) return false;
        const size_t kind=i.restore?0:target_kinds[i.target];
        if(security_hash(i,false)==security_hash(i,true)) return true;
        const auto text=provision::sddl(kind,i.host_sid,i.app_sid);
        provision::Local sd; ULONG size=0;
        if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(text.c_str(),SDDL_REVISION_1,&sd.value,&size) ||
            size>4096 || !provision::verify(sd.value,kind,i.host_sid,i.app_sid)) return false;
        PACL dacl=nullptr,sacl=nullptr; BOOL present=FALSE,defaulted=FALSE;
        if(!GetSecurityDescriptorDacl(sd.value,&present,&dacl,&defaulted) || !present || !dacl || defaulted ||
            !GetSecurityDescriptorSacl(sd.value,&present,&sacl,&defaulted) || !present || !sacl || defaulted) return false;
        // Both directions use verified fixed templates. No null DACL, inheritance or arbitrary SDDL.
        const DWORD error=SetSecurityInfo(target.value,SE_FILE_OBJECT,DACL_SECURITY_INFORMATION|SACL_SECURITY_INFORMATION|
            PROTECTED_DACL_SECURITY_INFORMATION|PROTECTED_SACL_SECURITY_INFORMATION,nullptr,nullptr,dacl,sacl);
        if(error!=ERROR_SUCCESS) return false; // Caller treats every post-intent failure as uncertain.
        Snapshot after; return snapshot(i,true,after);
    }
};
}
std::unique_ptr<Port> make_win32_port() { return std::make_unique<Win32Port>(); }
} // namespace permission_mutation
