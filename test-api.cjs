const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/api/create-user',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json'
  }
};

const req = http.request(options, (res) => {
  console.log(`STATUS: ${res.statusCode}`);
  res.setEncoding('utf8');
  res.on('data', (chunk) => console.log(`BODY: ${chunk}`));
});

req.on('error', (e) => console.error(`problem with request: ${e.message}`));
req.write(JSON.stringify({name: 'test', email: 'test@test.com'}));
req.end();
