package network

import (
	"fmt"
	"net"
)

// DetectURLs returns all reachable server base URLs for this machine,
// ordered: localhost → LAN → Tailscale.
// Public IPs are excluded (require HTTPS, handled post-M1).
func DetectURLs(port int) []string {
	urls := []string{fmt.Sprintf("http://localhost:%d", port)}

	ifaces, err := net.Interfaces()
	if err != nil {
		return urls
	}

	var lan, tailscale []string

	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ip := addrIP(addr)
			if ip == nil || ip.IsLoopback() || ip.To4() == nil {
				continue // IPv4 only for now
			}
			u := fmt.Sprintf("http://%s:%d", ip.String(), port)
			if isTailscale(ip) {
				// Tailscale uses 100.64.0.0/10 (CGNAT), not considered "private" by Go.
				tailscale = append(tailscale, u)
			} else if ip.IsPrivate() {
				lan = append(lan, u)
			}
			// Public IPs skipped — HTTPS required, handled post-M1.
		}
	}

	urls = append(urls, lan...)
	urls = append(urls, tailscale...)
	return urls
}

func addrIP(addr net.Addr) net.IP {
	switch v := addr.(type) {
	case *net.IPNet:
		return v.IP
	case *net.IPAddr:
		return v.IP
	}
	return nil
}

// Tailscale occupies the 100.64.0.0/10 CGNAT range.
func isTailscale(ip net.IP) bool {
	_, cgnat, _ := net.ParseCIDR("100.64.0.0/10")
	return cgnat != nil && cgnat.Contains(ip)
}
