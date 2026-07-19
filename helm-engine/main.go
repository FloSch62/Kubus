// helm-engine: Helm's chart rendering pipeline compiled to WASI, so the
// Kubus server can install/upgrade releases without a helm binary.
//
// Usage: helm-engine <input.json> <output.json>
// Input/output live in a preopened directory supplied by the Node host.
package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path"
	"strings"

	"helm.sh/helm/v3/pkg/chart"
	"helm.sh/helm/v3/pkg/chart/loader"
	"helm.sh/helm/v3/pkg/chartutil"
	"helm.sh/helm/v3/pkg/engine"
	"helm.sh/helm/v3/pkg/release"
	"helm.sh/helm/v3/pkg/releaseutil"
)

const notesFileSuffix = "NOTES.txt"

type input struct {
	Op string `json:"op"` // "render" | "inspect"
	// Exactly one chart source:
	ChartArchive string          `json:"chartArchive,omitempty"` // base64 .tgz
	ChartJSON    json.RawMessage `json:"chartJSON,omitempty"`    // chart object as stored in a release payload

	Values  map[string]interface{} `json:"values,omitempty"`
	Release struct {
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		Revision  int    `json:"revision"`
		IsInstall bool   `json:"isInstall"`
		IsUpgrade bool   `json:"isUpgrade"`
	} `json:"release"`
	KubeVersion string   `json:"kubeVersion,omitempty"`
	APIVersions []string `json:"apiVersions,omitempty"`
}

type crdFile struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type renderOutput struct {
	Manifest       string          `json:"manifest"`
	Hooks          []*release.Hook `json:"hooks"`
	Notes          string          `json:"notes"`
	CRDs           []crdFile       `json:"crds"`
	ChartJSON      json.RawMessage `json:"chartJSON"`
	Metadata       *chart.Metadata `json:"metadata"`
	ComputedValues interface{}     `json:"computedValues"`
}

type inspectOutput struct {
	Metadata   *chart.Metadata        `json:"metadata"`
	Values     map[string]interface{} `json:"values"`
	ValuesYaml string                 `json:"valuesYaml"`
	Readme     string                 `json:"readme"`
}

type errorOutput struct {
	Error string `json:"error"`
}

func main() {
	if err := run(); err != nil {
		writeOutput(errorOutput{Error: err.Error()})
		os.Exit(0) // error is reported via the output file, not the exit code
	}
}

func run() error {
	if len(os.Args) != 3 {
		return fmt.Errorf("usage: helm-engine <input.json> <output.json>")
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		return fmt.Errorf("read input: %w", err)
	}
	var in input
	if err := json.Unmarshal(raw, &in); err != nil {
		return fmt.Errorf("parse input: %w", err)
	}

	ch, err := loadChart(&in)
	if err != nil {
		return err
	}

	switch in.Op {
	case "inspect":
		return inspect(ch)
	case "render":
		return renderChart(ch, &in)
	default:
		return fmt.Errorf("unknown op %q", in.Op)
	}
}

func loadChart(in *input) (*chart.Chart, error) {
	if in.ChartArchive != "" {
		data, err := base64.StdEncoding.DecodeString(in.ChartArchive)
		if err != nil {
			return nil, fmt.Errorf("decode chart archive: %w", err)
		}
		ch, err := loader.LoadArchive(bytes.NewReader(data))
		if err != nil {
			return nil, fmt.Errorf("load chart archive: %w", err)
		}
		return ch, nil
	}
	if len(in.ChartJSON) > 0 {
		var ch chart.Chart
		if err := json.Unmarshal(in.ChartJSON, &ch); err != nil {
			return nil, fmt.Errorf("parse stored chart: %w", err)
		}
		return &ch, nil
	}
	return nil, fmt.Errorf("no chart source (chartArchive or chartJSON) provided")
}

func inspect(ch *chart.Chart) error {
	out := inspectOutput{Metadata: ch.Metadata, Values: ch.Values}
	for _, f := range ch.Raw {
		if f.Name == chartutil.ValuesfileName {
			out.ValuesYaml = string(f.Data)
		}
	}
	for _, f := range ch.Files {
		if strings.EqualFold(f.Name, "README.md") {
			out.Readme = string(f.Data)
		}
	}
	return writeOutput(out)
}

func renderChart(ch *chart.Chart, in *input) error {
	if err := chartutil.ProcessDependencies(ch, in.Values); err != nil {
		return fmt.Errorf("process dependencies: %w", err)
	}

	caps := chartutil.DefaultCapabilities.Copy()
	if in.KubeVersion != "" {
		kv, err := chartutil.ParseKubeVersion(in.KubeVersion)
		if err != nil {
			return fmt.Errorf("parse kube version %q: %w", in.KubeVersion, err)
		}
		caps.KubeVersion = *kv
	}
	if len(in.APIVersions) > 0 {
		caps.APIVersions = chartutil.VersionSet(in.APIVersions)
	}

	opts := chartutil.ReleaseOptions{
		Name:      in.Release.Name,
		Namespace: in.Release.Namespace,
		Revision:  in.Release.Revision,
		IsInstall: in.Release.IsInstall,
		IsUpgrade: in.Release.IsUpgrade,
	}
	// Match Helm's install/upgrade path: coalesce chart defaults and user values,
	// then validate the result against values.schema.json when the chart ships one.
	valuesToRender, err := chartutil.ToRenderValuesWithSchemaValidation(ch, in.Values, opts, caps, false)
	if err != nil {
		return err
	}

	files, err := engine.Engine{}.Render(ch, valuesToRender)
	if err != nil {
		return err
	}

	// NOTES.txt handling mirrors action.renderResources: keep only the top-level
	// chart's notes, drop all notes files from the manifest set.
	var notesBuf strings.Builder
	for k, v := range files {
		if !strings.HasSuffix(k, notesFileSuffix) {
			continue
		}
		if k == path.Join(ch.Name(), "templates", notesFileSuffix) {
			notesBuf.WriteString(v)
		}
		delete(files, k)
	}

	hooks, manifests, err := releaseutil.SortManifests(files, caps.APIVersions, releaseutil.InstallOrder)
	if err != nil {
		return err
	}
	if hooks == nil {
		hooks = []*release.Hook{}
	}

	var b strings.Builder
	for _, m := range manifests {
		fmt.Fprintf(&b, "---\n# Source: %s\n%s\n", m.Name, m.Content)
	}

	chartJSON, err := json.Marshal(ch)
	if err != nil {
		return fmt.Errorf("marshal chart: %w", err)
	}

	out := renderOutput{
		Manifest:       b.String(),
		Hooks:          hooks,
		Notes:          notesBuf.String(),
		CRDs:           []crdFile{},
		ChartJSON:      chartJSON,
		Metadata:       ch.Metadata,
		ComputedValues: valuesToRender["Values"],
	}
	for _, crd := range ch.CRDObjects() {
		out.CRDs = append(out.CRDs, crdFile{Name: crd.Name, Content: string(crd.File.Data)})
	}
	return writeOutput(out)
}

func writeOutput(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return os.WriteFile(os.Args[2], data, 0o644)
}
