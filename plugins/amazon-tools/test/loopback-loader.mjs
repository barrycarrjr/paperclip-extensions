// Test-only transport adapter. The built worker keeps its real HTTPS request
// construction and stdio protocol; requests are redirected to an isolated
// loopback HTTP fixture. This file is never bundled or installed.
import https from "node:https";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
const port=Number(process.env.AMAZON_TEST_PORT);
if(!Number.isInteger(port)||port<1)throw Error("Missing isolated fixture port");
https.request=function(url,options,callback){
  return http.request({hostname:"127.0.0.1",port,agent:false,path:url.pathname+url.search,method:options.method,headers:{...options.headers,"x-test-original-host":url.hostname}},callback);
};
syncBuiltinESMExports();
