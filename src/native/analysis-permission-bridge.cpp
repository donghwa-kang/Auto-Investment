#include "permission-mutation.hpp"
#include <aclapi.h>
#include <sstream>
#include <cstdio>

namespace bridge {
using provision::require;
using namespace permission_mutation;
unsigned checkpoint=0;
// One bounded ASCII line per handshake; no command can enable OS mutations.
std::string line() {
    HANDLE in=GetStdHandle(STD_INPUT_HANDLE);
    require(GetFileType(in)==FILE_TYPE_PIPE);
    std::string result;
    const auto start=GetTickCount64();
    while(GetTickCount64()-start<5000) {
        DWORD available=0,read=0;
        require(PeekNamedPipe(in,nullptr,0,nullptr,&available,nullptr)!=FALSE);
        if(!available){Sleep(2);continue;}
        char c=0;
        require(ReadFile(in,&c,1,&read,nullptr)!=FALSE && read==1);
        if(c=='\n') return result;
        require(c>=32 && c<=126 && result.size()<4096);
        result+=c;
    }
    throw 1;
}
std::vector<std::string> fields(const std::string& value) {
    std::vector<std::string> parts; std::istringstream in(value); std::string part,canonical;
    while(in>>part){parts.push_back(part);if(!canonical.empty())canonical+=' ';canonical+=part;}
    require(canonical==value);return parts;
}
void send(const std::string& text){require(file_probe::write_pipe(text+"\n"));}
std::wstring cwd(){
    std::array<wchar_t,512> b{}; DWORD n=GetCurrentDirectoryW(static_cast<DWORD>(b.size()),b.data());
    require(n && n<b.size() && file_probe::plain_local_path(b.data()));return b.data();
}
std::string dummy(const std::string& lab,size_t index){
    return "BRIDGE_DUMMY_V1\n"+lab+"\n"+std::to_string(index)+"\n";
}
struct Identity { std::string node,full; };
Identity identity(HANDLE h){
    BY_HANDLE_FILE_INFORMATION b{};FILE_ID_INFO f{};
    require(GetFileInformationByHandle(h,&b)!=FALSE && GetFileInformationByHandleEx(h,FileIdInfo,&f,sizeof(f))!=FALSE);
    const ULONGLONG index=(static_cast<ULONGLONG>(b.nFileIndexHigh)<<32)|b.nFileIndexLow;
    // Node's bigint stat identity is independently checked against the 64-bit API.
    return {file_probe::sha256(std::to_string(b.dwVolumeSerialNumber)+"\n"+std::to_string(index)+"\n"),
        file_probe::sha256(std::string(reinterpret_cast<char*>(&f),sizeof(f)))};
}
struct Model final:Port {
    std::wstring root,host;std::string lab;
    std::vector<file_probe::Handle> ancestors;
    std::array<file_probe::Handle,16> handles;
    std::array<Identity,16> ids;
    std::array<bool,16> applied{};
    Kind kind()const noexcept override{return Kind::Model;}
    void open(const std::wstring& workspace,const std::string& id,const std::wstring& owner){
        lab=id;host=owner;root=workspace+L"\\work\\analysis-permission-bridge-lab\\lab-"+file_probe::widen(id)+L"\\fixture";
        require(file_probe::plain_local_path(root));
        size_t end=3;
        while((end=root.find(L'\\',end))!=std::wstring::npos){
            checkpoint=static_cast<unsigned>(100+end);
            const auto path=root.substr(0,end);
            file_probe::Handle h(CreateFileW(path.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ|FILE_SHARE_WRITE,
                nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(h.valid() && file_probe::same_file(h.value,path,true));
            ancestors.push_back(std::move(h));++end;
        }
        for(size_t i=0;i<16;++i){
            checkpoint=static_cast<unsigned>(20+i);
            const auto path=root+(i?L"\\"+std::wstring(paths[i]):L"");
            const DWORD access=READ_CONTROL|FILE_READ_ATTRIBUTES|(i>=7?FILE_READ_DATA:0);
            handles[i]=file_probe::Handle(CreateFileW(path.c_str(),access,i<7?FILE_SHARE_READ|FILE_SHARE_WRITE:FILE_SHARE_READ,
                nullptr,OPEN_EXISTING,FILE_FLAG_BACKUP_SEMANTICS|FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
            require(handles[i].valid());ids[i]=identity(handles[i].value);require(check(i));
        }
    }
    bool check(size_t n){
        const auto path=root+(n?L"\\"+std::wstring(paths[n]):L"");
        HANDLE h=handles[n].value;
        if(!file_probe::same_file(h,path,n<7) || identity(h).full!=ids[n].full) return false;
        provision::Local sd;PSID owner=nullptr;
        if(GetSecurityInfo(h,SE_FILE_OBJECT,OWNER_SECURITY_INFORMATION,&owner,nullptr,nullptr,nullptr,
            reinterpret_cast<PSECURITY_DESCRIPTOR*>(&sd.value))!=ERROR_SUCCESS || !provision::equal_text_sid(owner,host)) return false;
        if(n>=7){
            LARGE_INTEGER zero{};std::string bytes;
            if(!SetFilePointerEx(h,zero,nullptr,FILE_BEGIN) || !file_probe::read_small(h,bytes,128) || bytes!=dummy(lab,n)) return false;
        }
        return true;
    }
    bool observe(const Intent& i,bool desired,Snapshot& out)override{
        if(!check(i.target) || applied[i.target]!=(desired!=i.restore))return false;
        out={ids[i.target].full,security_hash(i,desired)};return true;
    }
    bool change(const Intent& i)override{
        if(!check(i.target) || applied[i.target]!=i.restore)return false;
        applied[i.target]=!i.restore;return true; // MEMORY ONLY. Never SetSecurityInfo.
    }
};
struct Journal final:JournalPort {
    bool before(const Intent& i,std::string& digest)override{
        const auto hash=intent_hash(i);send("BEFORE "+i.operation_id+" "+hash);
        const auto f=fields(line());
        if(f.size()!=4 || f[0]!="ACK_BEFORE" || f[1]!=i.operation_id || f[2]!=hash || !analysis_validator::hash(f[3]))return false;
        digest=hash;return true;
    }
    bool after(const Intent& i,bool verified)override{
        send("AFTER "+i.operation_id+(verified?" VERIFIED":" UNCERTAIN"));const auto f=fields(line());
        return f.size()==3 && f[0]=="ACK_AFTER" && f[1]==i.operation_id && analysis_validator::hash(f[2]);
    }
};
int execute(){
    checkpoint=1;
    const auto init=line(), f0=init;const auto f=fields(f0);
    require(f.size()==5 && f[0]=="BRIDGE_MODEL_V1" && analysis_validator::uuid(f[1]) &&
        analysis_validator::uuid(f[2]) && analysis_validator::hash(f[3]) && analysis_validator::hash(f[4]));
    checkpoint=2;
    const auto workspace=cwd(),host=provision::host_sid(),app=provision::app_sid(f[2]);
    const auto owner_hash=file_probe::sha256(provision::ascii(host));require(owner_hash==f[4]);
    checkpoint=3;
    Model model;model.open(workspace,f[1],host);Journal journal;
    Intent intent;intent.run_id=f[2];intent.plan_sha256=f[3];intent.host_sid=host;intent.app_sid=app;
    intent.root=workspace+L"\\work\\analysis-os-lab\\run-"+file_probe::widen(f[2]);
    auto locked=make_win32_port();require(run(*locked,journal,intent)==Result::Locked);
    std::string ready="READY "+file_probe::sha256(init+"\n")+" "+owner_hash;
    for(const auto& id:model.ids)ready+=' '+id.node+' '+id.full;
    send(ready);
    checkpoint=40;
    std::vector<std::string> operations;
    for(size_t step=0;step<32;++step){
        const auto op=fields(line());require(op.size()==2 && op[0]=="OP" && analysis_validator::uuid(op[1]) &&
            std::find(operations.begin(),operations.end(),op[1])==operations.end());
        operations.push_back(op[1]);intent.operation_id=op[1];intent.target=step<16?step:31-step;intent.restore=step>=16;
        intent.object_id=model.ids[intent.target].full;
        const auto result=run(model,journal,intent);
        if(result!=Result::VerifiedModel){send("HOLD "+op[1]);return 2;}
        send("DONE "+op[1]);
    }
    require(line()=="END");
    std::string tail;require(file_probe::read_pipe(tail,1) && tail.empty());
    send("COMPLETE 32 WIN32_LOCKED");return 0;
}
}
int wmain(int argc,wchar_t** argv){
    if(argc!=2 || std::wstring_view(argv[1])!=L"--stdio-model")return 2;
    try{return bridge::execute();}catch(...){std::fprintf(stderr,"BRIDGE_NATIVE_HOLD_%u_WIN32_%lu\n",bridge::checkpoint,GetLastError());return 2;}
}
