package cmd

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"

	"github.com/spf13/cobra"
	"github.com/symunona/samizdat/cli/config"
)

var deviceCmd = &cobra.Command{
	Use:   "device",
	Short: "Manage paired devices",
}

var deviceListCmd = &cobra.Command{
	Use:   "list",
	Short: "List all paired devices",
	RunE:  runDeviceList,
}

var deviceRevokeCmd = &cobra.Command{
	Use:   "revoke <id>",
	Short: "Revoke a device by ID",
	Args:  cobra.ExactArgs(1),
	RunE:  runDeviceRevoke,
}

func init() {
	deviceCmd.AddCommand(deviceListCmd)
	deviceCmd.AddCommand(deviceRevokeCmd)
	Root.AddCommand(deviceCmd)
}

func loadPort() (int, error) {
	cfgPath, err := config.DefaultPath()
	if err != nil {
		return 0, err
	}
	cfg, err := config.Load(cfgPath)
	if err != nil {
		return 0, fmt.Errorf("load config: %w", err)
	}
	return cfg.Server.Port, nil
}

func runDeviceList(_ *cobra.Command, _ []string) error {
	port, err := loadPort()
	if err != nil {
		return err
	}

	url := fmt.Sprintf("http://localhost:%d/admin/devices", port)
	resp, err := http.Get(url) //nolint:noctx
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		fmt.Fprintf(os.Stderr, "server returned %s\n", resp.Status)
		return fmt.Errorf("server error")
	}

	var result struct {
		Devices []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"created_at"`
		} `json:"devices"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("decode response: %w", err)
	}

	if len(result.Devices) == 0 {
		fmt.Println("No paired devices.")
		return nil
	}

	fmt.Printf("%-36s  %-20s  %s\n", "ID", "NAME", "CREATED")
	for _, d := range result.Devices {
		fmt.Printf("%-36s  %-20s  %s\n", d.ID, d.Name, d.CreatedAt)
	}
	return nil
}

func runDeviceRevoke(_ *cobra.Command, args []string) error {
	id := args[0]

	port, err := loadPort()
	if err != nil {
		return err
	}

	url := fmt.Sprintf("http://localhost:%d/admin/devices/%s", port, id)
	req, err := http.NewRequest(http.MethodDelete, url, nil)
	if err != nil {
		return fmt.Errorf("build request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req) //nolint:noctx
	if err != nil {
		fmt.Fprintf(os.Stderr, "Could not reach server on port %d. Is `samizdat serve` running?\n", port)
		return err
	}
	defer resp.Body.Close()

	switch resp.StatusCode {
	case http.StatusNoContent:
		fmt.Printf("Device %s revoked.\n", id)
	case http.StatusNotFound:
		fmt.Fprintf(os.Stderr, "Device %s not found.\n", id)
		return fmt.Errorf("not found")
	default:
		fmt.Fprintf(os.Stderr, "server returned %s\n", resp.Status)
		return fmt.Errorf("server error")
	}
	return nil
}
