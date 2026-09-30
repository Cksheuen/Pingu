#!/usr/bin/env python3
"""Explicit, isolated native-core fault test. Never changes system proxy or real nodes.
Usage: python3 scripts/verify-chain-failover.py MIHOMO GENERATED_RUNTIME_JSON
The group under test is taken from Pingu's generated config; local SOCKS servers
replace its transports and a local 204 endpoint replaces the health URL.
"""
import copy
import http.client
import http.server
import json
import pathlib
import select
import socket
import socketserver
import struct
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request

ENTRY, CHAIN, EXIT, ROUTE = 'Pingu Chain Entry', 'Pingu Chain', 'Pingu Chain Exit Only', 'Pingu Chain Route'

class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True
    enabled = True

class Socks(socketserver.BaseRequestHandler):
    def handle(self):
        def take(n):
            data = b''
            while len(data) < n:
                part = self.request.recv(n-len(data))
                if not part: raise OSError('closed')
                data += part
            return data
        try:
            self.request.settimeout(5)
            if not self.server.enabled: return
            ver, count = take(2); take(count)
            self.request.sendall(b'\x05\x00')
            ver, command, _, kind = take(4)
            if kind == 1: host = socket.inet_ntoa(take(4))
            elif kind == 3: host = take(take(1)[0]).decode()
            else: return
            port = struct.unpack('!H', take(2))[0]
            with socket.create_connection((host,port),timeout=3) as other:
                self.server.targets.append(port)
                self.request.sendall(b'\x05\x00\x00\x01\x7f\x00\x00\x01\x00\x00')
                while self.server.enabled:
                    ready,_,_ = select.select([self.request,other],[],[],.2)
                    for source in ready:
                        data=source.recv(65536)
                        if not data: return
                        (other if source is self.request else self.request).sendall(data)
        except OSError: pass

class Destination(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(204); self.send_header('Connection','close'); self.end_headers()
    do_HEAD = do_GET
    def log_message(self,*args): pass

def start(handler):
    server=Server(('127.0.0.1',0),handler); server.targets=[]
    threading.Thread(target=server.serve_forever,daemon=True).start()
    return server

def unused():
    with socket.socket() as s: s.bind(('127.0.0.1',0)); return s.getsockname()[1]

def run():
    generated=json.loads(pathlib.Path(sys.argv[2]).read_text())
    group=copy.deepcopy(next(g for g in generated['proxy-groups'] if g['name']==ROUTE))
    entry,exit_node,dest=start(Socks),start(Socks),start(Destination)
    core=None
    try:
        api, mixed=unused(),unused()
        url=f'http://127.0.0.1:{dest.server_address[1]}/generate_204'
        group['url']=url
        proxies=[]
        for name,server,dialer in [(ENTRY,entry,None),(CHAIN,exit_node,ENTRY),(EXIT,exit_node,None)]:
            original=next(p for p in generated['proxies'] if p['name']==name)
            assert original.get('dialer-proxy')==dialer
            p={'name':name,'type':'socks5','server':'127.0.0.1','port':server.server_address[1]}
            if dialer: p['dialer-proxy']=dialer
            proxies.append(p)
        config={'mixed-port':mixed,'external-controller':f'127.0.0.1:{api}','allow-lan':False,'dns':{'enable':False},'log-level':'silent','proxies':proxies,'proxy-groups':[group],'rules':[f'MATCH,{ROUTE}']}
        def status():
            with urllib.request.urlopen(f'http://127.0.0.1:{api}/proxies',timeout=2) as r: return json.load(r)['proxies']
        def request():
            c=http.client.HTTPConnection('127.0.0.1',mixed,timeout=5)
            try: c.request('GET',url); return c.getresponse().status
            except (OSError,http.client.HTTPException): return 0
            finally: c.close()
        def wait_for(expected, dead=False):
            start=time.monotonic()
            while time.monotonic()-start<22:
                try:
                    nodes=status(); now=nodes[ROUTE]['now']; health=nodes[now].get('extra',{}).get(url,{})
                    ready=bool(health.get('history')) and health.get('alive') is not dead
                    if now==expected and ready:
                        before_entry=len(entry.targets); before_exit=len(exit_node.targets)
                        response=request()
                        assert (response==204) is not dead, (expected,response)
                        if not dead:
                            if expected==CHAIN: assert exit_node.server_address[1] in entry.targets[before_entry:] and dest.server_address[1] in exit_node.targets[before_exit:]
                            elif expected==EXIT: assert dest.server_address[1] in exit_node.targets[before_exit:]
                            else: assert dest.server_address[1] in entry.targets[before_entry:]
                        print(json.dumps({'route':expected,'both_down':dead,'transition_seconds':round(time.monotonic()-start,2),'request_status':response,'health':health},ensure_ascii=False),flush=True)
                        return
                except (OSError,ValueError): pass
                time.sleep(.25)
            raise AssertionError(f'No transition to {expected}; {json.dumps(status())}')
        with tempfile.TemporaryDirectory(prefix='pingu-failover-') as d:
            path=pathlib.Path(d)/'config.json'; path.write_text(json.dumps(config)); path.chmod(0o600)
            core=subprocess.Popen([sys.argv[1],'-f',str(path),'-d',d],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            wait_for(CHAIN)
            entry.enabled=False; wait_for(EXIT)
            entry.enabled=True; wait_for(CHAIN)
            exit_node.enabled=False; wait_for(ENTRY)
            exit_node.enabled=True; wait_for(CHAIN)
            entry.enabled=False; exit_node.enabled=False; wait_for(CHAIN,True)
            entry.enabled=True; exit_node.enabled=True; wait_for(CHAIN)
            print('PASS: entry failure, exit failure, both failures, and automatic recovery; actual requests verified.',flush=True)
    finally:
        if core: core.terminate(); core.wait(timeout=5)
        for s in (entry,exit_node,dest): s.shutdown(); s.server_close()

if __name__=='__main__': run()
