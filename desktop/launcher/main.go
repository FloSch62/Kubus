// Kubus URL relay. Electrobun 2.0's launcher does not forward argv to Bun.
// Keep the native launcher in charge of platform setup and pass links via env.
package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

func main() {
	executable, err := os.Executable()
	if err != nil {
		os.Exit(1)
	}
	name := "launcher"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	command := exec.Command(filepath.Join(filepath.Dir(executable), name))
	command.Env = os.Environ()
	for _, arg := range os.Args[1:] {
		if strings.HasPrefix(arg, "kubus://") {
			command.Env = append(command.Env, "KUBUS_DEEP_LINK="+arg)
			break
		}
	}
	if err := command.Start(); err != nil {
		os.Exit(1)
	}
	// The launcher owns its child and the app remains alive after this relay exits.
	_ = command.Process.Release()
}
