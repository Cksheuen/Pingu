package main
import (
 "net/http/httptest"
 "strings"
 "testing"
)
func TestExposureAPIRejectsBrowserAndUnauthenticatedWrites(t *testing.T) {
 token := strings.Repeat("a", 64)
 app := &meshApp{gate:newInboundGate(9081), token:token}
 for _, header := range []string{"",token,"Bearer wrong"} {
  req := httptest.NewRequest("POST","http://localhost/exposure",strings.NewReader(`{"enabled":true,"ports":[22]}`))
  req.Header.Set("Authorization",header)
  res := httptest.NewRecorder(); app.ServeHTTP(res,req)
  if res.Code != 401 { t.Fatalf("bad auth accepted: %d",res.Code) }
 }
 req := httptest.NewRequest("POST","http://localhost/exposure",strings.NewReader(`{"enabled":true,"ports":[22]}`))
 req.Header.Set("Authorization","Bearer "+token); req.Header.Set("Origin","https://attacker.example")
 res := httptest.NewRecorder(); app.ServeHTTP(res,req)
 if res.Code != 401 { t.Fatal("browser origin accepted") }
 req.Header.Del("Origin"); res=httptest.NewRecorder(); app.ServeHTTP(res,req)
 if res.Code != 200 { t.Fatalf("authorized write failed: %d",res.Code) }
 enabled,ports,_:=app.gate.snapshot(); if !enabled || len(ports)!=1 || ports[0]!=22 { t.Fatal("policy not applied") }
}
