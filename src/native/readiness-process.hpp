#pragma once
#include "readiness-inspection.hpp"

namespace readiness {
inline std::wstring own_image(){std::array<wchar_t,512>b{};const DWORD n=GetModuleFileNameW(nullptr,b.data(),static_cast<DWORD>(b.size()));require(n&&n<b.size()&&file_probe::plain_local_path(b.data()));return b.data();}
inline std::string filetime(FILETIME t){return std::to_string((static_cast<ULONGLONG>(t.dwHighDateTime)<<32)|t.dwLowDateTime);}
struct ProcessEvidence {std::string payload,creation,exit_time,image_id;DWORD pid=0,code=0;bool forced=false,signaled=false;};
// This supervisor never accepts a PID or executable path. Its only target is the self-image it creates.
inline ProcessEvidence supervise(const std::wstring& mode,const std::string& input,DWORD limit){
    require(mode==L"--read-only-child"||mode==L"--exit-normal-child"||mode==L"--exit-nonzero-child"||mode==L"--exit-claim-child");
    const auto image=own_image();Handle image_file(CreateFileW(image.c_str(),FILE_READ_ATTRIBUTES,FILE_SHARE_READ,nullptr,OPEN_EXISTING,FILE_FLAG_OPEN_REPARSE_POINT,nullptr));
    require(image_file.valid()&&file_probe::same_file(image_file.value,image));
    SECURITY_ATTRIBUTES sa{sizeof(sa),nullptr,TRUE};HANDLE ri=nullptr,wi=nullptr,ro=nullptr,wo=nullptr;
    require(CreatePipe(&ri,&wi,&sa,0)!=FALSE);Handle input_read(ri),input_write(wi);
    require(CreatePipe(&ro,&wo,&sa,0)!=FALSE);Handle output_read(ro),output_write(wo);
    require(SetHandleInformation(input_write.value,HANDLE_FLAG_INHERIT,0)!=FALSE&&SetHandleInformation(output_read.value,HANDLE_FLAG_INHERIT,0)!=FALSE);
    SIZE_T size=0;InitializeProcThreadAttributeList(nullptr,1,0,&size);require(size&&size<65536);
    std::vector<std::byte> memory(size);auto attrs=reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());
    require(InitializeProcThreadAttributeList(attrs,1,0,&size)!=FALSE);
    struct Attributes {LPPROC_THREAD_ATTRIBUTE_LIST value;~Attributes(){DeleteProcThreadAttributeList(value);}} cleanup{attrs};
    std::array<HANDLE,2> inherited{input_read.value,output_write.value};
    require(UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,inherited.data(),sizeof(inherited),nullptr,nullptr)!=FALSE);
    STARTUPINFOEXW start{};start.StartupInfo.cb=sizeof(start);start.StartupInfo.dwFlags=STARTF_USESTDHANDLES;
    start.StartupInfo.hStdInput=input_read.value;start.StartupInfo.hStdOutput=output_write.value;start.StartupInfo.hStdError=output_write.value;start.lpAttributeList=attrs;
    PROCESS_INFORMATION pi{};std::wstring command=L"\""+image+L"\" "+mode;
    wchar_t environment[]=L"SystemRoot=C:\\Windows\0WINDIR=C:\\Windows\0";
    require(CreateProcessW(image.c_str(),command.data(),nullptr,nullptr,TRUE,CREATE_NO_WINDOW|CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|EXTENDED_STARTUPINFO_PRESENT,
        environment,cwd().c_str(),&start.StartupInfo,&pi)!=FALSE);
    Handle process(pi.hProcess),thread(pi.hThread);ProcessEvidence evidence;evidence.pid=pi.dwProcessId;evidence.image_id=id(image_file.value);
    // All exceptional cleanup is restricted to this exact creation handle, never a PID lookup.
    struct Owned {HANDLE value;bool done=false;~Owned(){if(!done){TerminateProcess(value,124);WaitForSingleObject(value,5000);}}} owned{process.value};
    FILETIME created{},ended{},kernel{},user{};require(GetProcessTimes(process.value,&created,&ended,&kernel,&user)!=FALSE);
    evidence.creation=filetime(created);
    std::array<wchar_t,512> running{};DWORD length=static_cast<DWORD>(running.size());
    require(QueryFullProcessImageNameW(process.value,0,running.data(),&length)!=FALSE&&_wcsicmp(running.data(),image.c_str())==0);
    require(GetProcessId(process.value)==pi.dwProcessId&&WaitForSingleObject(process.value,0)==WAIT_TIMEOUT);
    input_read.reset();output_write.reset();
    DWORD count=0;require(input.size()<=384&&WriteFile(input_write.value,input.data(),static_cast<DWORD>(input.size()),&count,nullptr)!=FALSE&&count==input.size());
    input_write.reset();require(ResumeThread(thread.value)!=static_cast<DWORD>(-1));thread.reset();
    const auto began=GetTickCount64();std::array<char,4096> buffer{};
    while(true){
        DWORD available=0;
        if(PeekNamedPipe(output_read.value,nullptr,0,nullptr,&available,nullptr)){
            if(available){const DWORD wanted=std::min(available,static_cast<DWORD>(buffer.size()));require(ReadFile(output_read.value,buffer.data(),wanted,&count,nullptr)!=FALSE&&count);
                require(evidence.payload.size()+count<=262144);evidence.payload.append(buffer.data(),count);continue;}
        }else require(GetLastError()==ERROR_BROKEN_PIPE);
        // Drain once more after observing termination: the child may have written
        // between PeekNamedPipe and the wait. A prior empty peek is not EOF.
        if(evidence.signaled)break;
        const DWORD wait=WaitForSingleObject(process.value,0);require(wait==WAIT_TIMEOUT||wait==WAIT_OBJECT_0);
        if(wait==WAIT_OBJECT_0){evidence.signaled=true;continue;}
        if(GetTickCount64()-began>=limit){
            evidence.forced=true;require(TerminateProcess(process.value,124)!=FALSE);
            require(WaitForSingleObject(process.value,5000)==WAIT_OBJECT_0);evidence.signaled=true;continue;
        }
        Sleep(2);
    }
    require(GetExitCodeProcess(process.value,&evidence.code)!=FALSE&&GetProcessTimes(process.value,&created,&ended,&kernel,&user)!=FALSE);
    require(filetime(created)==evidence.creation&&filetime(ended)!="0");evidence.exit_time=filetime(ended);owned.done=true;
    return evidence;
}
inline std::string process_json(const ProcessEvidence& e){
    return "{\"pid\":"+std::to_string(e.pid)+",\"creationTime\":\""+e.creation+"\",\"exitTime\":\""+e.exit_time+"\",\"imageObjectId\":\""+e.image_id+
        "\",\"waitSignaled\":"+(e.signaled?"true":"false")+",\"forced\":"+(e.forced?"true":"false")+",\"exitCode\":"+std::to_string(e.code)+",\"scope\":\"CREATED_SELF_CHILD_ONLY\"}";
}
} // namespace readiness
