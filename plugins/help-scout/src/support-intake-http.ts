/** The host HTTP bridge rejects private/loopback addresses and cannot transport
 * AbortSignals. This fixed, operator-configured intake client intentionally uses
 * native fetch so a local Paperclip API and its actual deadline work. */
export async function postSupportIntake(endpoint:string,key:string,message:Record<string,unknown>,deadline:number,send:(url:string,init?:RequestInit)=>Promise<Response>=globalThis.fetch) {
  const url=new URL(endpoint);
  if(url.username||url.password||url.search||url.hash||url.pathname!=="/api/plugins/customer-support/api/messages"||
    (url.protocol!=="https:"&&!(url.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(url.hostname))))throw new Error("Invalid fixed intake endpoint");
  const remaining=deadline-Date.now();if(remaining<=0||!key)throw new Error("Intake key or work budget unavailable");
  const response=await send(url.href,{method:"POST",redirect:"manual",signal:AbortSignal.timeout(Math.max(1,Math.min(15000,remaining))),headers:{Authorization:`Bearer ${key}`,"Content-Type":"application/json"},body:JSON.stringify(message)});
  if(![200,201].includes(response.status)){await response.body?.cancel();throw new Error("Support Desk intake not acknowledged");}
  const reader=response.body?.getReader();if(!reader)throw new Error("Missing intake acknowledgement");let text="",size=0;const decoder=new TextDecoder();
  try{while(true){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>2000)throw new Error("Invalid intake acknowledgement");text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  const ack=JSON.parse(text) as {caseId?:string;created?:boolean};
  if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ack.caseId??"")||typeof ack.created!=="boolean")throw new Error("Invalid intake acknowledgement");
  return{caseId:ack.caseId!,created:ack.created};
}
