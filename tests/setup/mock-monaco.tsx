interface EditorProps {
  value?: string;
  onChange?: (value: string | undefined) => void;
  options?: { readOnly?: boolean };
}

export default function MockMonacoEditor({ value, onChange, options }: EditorProps) {
  return (
    <textarea
      aria-label={options?.readOnly ? 'Read-only YAML editor' : 'YAML editor'}
      value={value ?? ''}
      readOnly={options?.readOnly}
      onChange={(event) => onChange?.(event.target.value)}
    />
  );
}
