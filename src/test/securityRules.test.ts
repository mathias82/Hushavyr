import assert from "node:assert/strict";
import {test} from "node:test";
import {scanSecurity} from "../securityRules";
test("detects insecure TLS and weak crypto",()=>{
 const found=scanSecurity("app.ts","const opts = {rejectUnauthorized: false};\ncreateHash('md5')");
 assert.deepEqual(found.map(x=>x.line),[1,2]);
});
test("detects Java deserialization",()=>{
 assert.equal(scanSecurity("Demo.java","ObjectInputStream input = new ObjectInputStream(socket.getInputStream());").length,1);
});
test("does not claim vulnerabilities in comments or unsupported files",()=>{
 assert.deepEqual(scanSecurity("Demo.java","// Runtime.getRuntime().exec(command)"),[]);
 assert.deepEqual(scanSecurity("notes.txt","rejectUnauthorized: false"),[]);
});
test("covers Go, C#, PHP and Python indicators without flagging safe forms",()=>{
 assert.equal(scanSecurity("main.go","tls.Config{InsecureSkipVerify: true}")[0].rule,"TLS certificate validation disabled");
 assert.equal(scanSecurity("Api.cs","handler.ServerCertificateValidationCallback = (m, c, ch, e) => true;")[0].rule,"TLS certificate validation disabled");
 assert.equal(scanSecurity("job.py","data = pickle.loads(blob)")[0].rule,"Unsafe Python deserialization");
 assert.equal(scanSecurity("job.py","yaml.load(text, Loader=yaml.SafeLoader)").length,0);
 assert.equal(scanSecurity("app.js","eval(userInput)")[0].rule,"Unsafe dynamic code evaluation");
 assert.equal(scanSecurity("app.js","eval('1+1')").length,0);
});
test("flags weak Java ciphers, key generators and insecure random but not AES/GCM or SecureRandom",()=>{
 const java=["Cipher c = Cipher.getInstance(\"DES/CBC/PKCS5Padding\");","Cipher e = Cipher.getInstance(\"AES/ECB/PKCS5Padding\");","SecretKey k = KeyGenerator.getInstance(\"DES\").generateKey();","MessageDigest md = MessageDigest.getInstance(\"SHA1\", \"SUN\");","double r = new java.util.Random().nextDouble();","Cipher g = Cipher.getInstance(\"AES/GCM/NoPadding\");","SecureRandom s = new SecureRandom();"].join("\n");
 assert.deepEqual(scanSecurity("Crypto.java",java).map(x=>x.line),[1,2,3,4,5]);
});
test("flags weak Python hashes, insecure random for tokens and cookies without secure",()=>{
 const py=["h = hashlib.new('md5')","h = hashlib.new('sha256')","h = hashlib.new('sha1', usedforsecurity=False)","token = random.getrandbits(64)","token = random.SystemRandom().random()","token = secrets.token_hex()",
  "resp.set_cookie('session', token,","    httponly=True,","    secure=False)","resp.set_cookie('session', token,","    secure=True)"].join("\n");
 assert.deepEqual(scanSecurity("app.py",py).map(x=>[x.line,x.rule]),[[1,"Weak cryptographic hash"],[4,"Insecure random number generator"],[7,"Insecure cookie"]]);
});
