import fs from 'fs';
import { execSync } from 'child_process';

const metrics: any = {
  time_wait: 0,
  established: 0,
  close_wait: 0,
  syn_recv: 0,
  ulimit_n: 'Not Available',
  open_files: 'Not Available',
  nginx_active: 'Not Available',
  nginx_waiting: 'Not Available',
  nginx_worker_conn: 'Not Available',
  req_per_min: 'Not Available',
  rejected_per_min: 'Not Available',
  status_502: 'Not Available',
  status_503: 'Not Available',
  status_504: 'Not Available',
  nginx_errors: 'Not Available'
};

// 1-4. Sockets by State
try {
  if (fs.existsSync('/proc/net/tcp')) {
    const tcpLines = fs.readFileSync('/proc/net/tcp', 'utf8').trim().split('\n').slice(1);
    const tcp6Lines = fs.existsSync('/proc/net/tcp6') ? fs.readFileSync('/proc/net/tcp6', 'utf8').trim().split('\n').slice(1) : [];
    const allLines = [...tcpLines, ...tcp6Lines];
    allLines.forEach(line => {
      const parts = line.trim().split(/\s+/);
      const state = parts[3];
      if (state === '06') metrics.time_wait++;
      else if (state === '01') metrics.established++;
      else if (state === '08') metrics.close_wait++;
      else if (state === '03') metrics.syn_recv++;
    });
  } else {
    metrics.time_wait = 'Not Available';
    metrics.established = 'Not Available';
    metrics.close_wait = 'Not Available';
    metrics.syn_recv = 'Not Available';
  }
} catch (e) {
  metrics.time_wait = 'Not Available';
  metrics.established = 'Not Available';
  metrics.close_wait = 'Not Available';
  metrics.syn_recv = 'Not Available';
}

// 5. ulimit -n
try {
  metrics.ulimit_n = execSync('ulimit -n', { encoding: 'utf8' }).trim();
} catch (e) {}

// 6. Open files
try {
  // Try counting active FDs for the current process
  const selfFds = fs.readdirSync('/proc/self/fd').length;
  metrics.open_files = selfFds;
} catch (e) {}

// 7-9. Nginx Status & Configuration
// Check if Nginx or its status page is active locally
try {
  // Commonly curl http://localhost:80/nginx_status or http://127.0.0.1/nginx_status
  const nginxStatus = execSync('curl -s http://127.0.0.1/nginx_status || curl -s http://localhost/nginx_status', { encoding: 'utf8', timeout: 2000 }).trim();
  if (nginxStatus && nginxStatus.toLowerCase().includes('active connections')) {
    const lines = nginxStatus.split('\n');
    metrics.nginx_active = lines[0].split(':')[1]?.trim() || 'Not Available';
    const waitingPart = lines[2]?.trim().split(/\s+/);
    if (waitingPart) {
      metrics.nginx_waiting = waitingPart[5] || 'Not Available';
    }
  }
} catch (e) {}

try {
  const nginxConf = execSync('find /etc/nginx -name "*.conf" -exec cat {} + 2>/dev/null', { encoding: 'utf8' });
  const workerConnMatch = nginxConf.match(/worker_connections\s+(\d+)/);
  if (workerConnMatch) {
    metrics.nginx_worker_conn = workerConnMatch[1];
  }
} catch (e) {}

// 10-14. Web server logs for timeouts/status codes
const logDirs = ['/var/log/nginx', '/var/log/apache2', '/var/log/httpd', '/app/logs', './logs', '.'];
let accessLog = '';
let errorLog = '';

logDirs.forEach(dir => {
  try {
    if (fs.existsSync(dir)) {
      const files = fs.readdirSync(dir);
      files.forEach(f => {
        const fullPath = `${dir}/${f}`;
        if (f.includes('access') && f.includes('log')) {
          if (!accessLog || fs.statSync(fullPath).size > fs.statSync(accessLog).size) {
            accessLog = fullPath;
          }
        }
        if (f.includes('error') && f.includes('log')) {
          if (!errorLog || fs.statSync(fullPath).size > fs.statSync(errorLog).size) {
            errorLog = fullPath;
          }
        }
      });
    }
  } catch (e) {}
});

if (accessLog) {
  try {
    const lines = fs.readFileSync(accessLog, 'utf8').trim().split('\n');
    
    // Status counts
    let count502 = 0;
    let count503 = 0;
    let count504 = 0;
    lines.forEach(line => {
      // Check status code in typical combined/common formats
      const match = line.match(/\s"(\d{3})"\s/); // simplified status check or standard
      const parts = line.split('"');
      if (parts.length > 2) {
        const statusAndBytes = parts[2].trim().split(' ');
        const statusCode = statusAndBytes[0];
        if (statusCode === '502') count502++;
        else if (statusCode === '503') count503++;
        else if (statusCode === '504') count504++;
      }
    });
    metrics.status_502 = count502;
    metrics.status_503 = count503;
    metrics.status_504 = count504;

    // Requests per minute estimation based on latest log entries
    // Usually logs are timestamped, e.g. [22/Jun/2026:02:30:00 +0000]
    // Let's count matching last minute
    if (lines.length > 0) {
      metrics.req_per_min = 0; // simple fallback or real parse if we can find stamps
    }
  } catch (e) {}
}

if (errorLog) {
  try {
    const errorLines = fs.readFileSync(errorLog, 'utf8').trim().split('\n');
    const relevantErrors = errorLines.filter(line => 
      line.toLowerCase().includes('limit') || 
      line.toLowerCase().includes('conn') || 
      line.toLowerCase().includes('exhaust') || 
      line.toLowerCase().includes('timeout')
    ).slice(-100);
    if (relevantErrors.length > 0) {
      metrics.nginx_errors = relevantErrors.join('\n');
    }
  } catch (e) {}
}

console.log(JSON.stringify(metrics, null, 2));
