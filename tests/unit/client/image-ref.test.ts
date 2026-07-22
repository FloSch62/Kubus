import { describe, expect, it } from 'vitest';
import { splitImageRef } from '../../../client/src/image-ref';

describe('splitImageRef', () => {
  it('handles bare images', () => {
    expect(splitImageRef('nginx')).toEqual({ repo: 'nginx', tag: undefined, digest: undefined });
    expect(splitImageRef('library/nginx')).toEqual({ repo: 'library/nginx', tag: undefined, digest: undefined });
  });

  it('splits the tag after the last slash', () => {
    expect(splitImageRef('nginx:1.25')).toEqual({ repo: 'nginx', tag: '1.25', digest: undefined });
    expect(splitImageRef('ghcr.io/acme/app:v2.1')).toEqual({ repo: 'ghcr.io/acme/app', tag: 'v2.1', digest: undefined });
  });

  it('keeps registry ports inside the repo', () => {
    expect(splitImageRef('localhost:5000/app')).toEqual({ repo: 'localhost:5000/app', tag: undefined, digest: undefined });
    expect(splitImageRef('localhost:5000/app:v2')).toEqual({ repo: 'localhost:5000/app', tag: 'v2', digest: undefined });
    expect(splitImageRef('registry.example.com:443/team/app:latest')).toEqual({
      repo: 'registry.example.com:443/team/app',
      tag: 'latest',
      digest: undefined,
    });
  });

  it('splits digests off at the @', () => {
    expect(splitImageRef('nginx@sha256:abc123')).toEqual({ repo: 'nginx', tag: undefined, digest: 'sha256:abc123' });
    expect(splitImageRef('localhost:5000/app@sha256:abc')).toEqual({
      repo: 'localhost:5000/app',
      tag: undefined,
      digest: 'sha256:abc',
    });
  });

  it('handles tag and digest together', () => {
    expect(splitImageRef('ghcr.io/acme/app:v1@sha256:abc')).toEqual({
      repo: 'ghcr.io/acme/app',
      tag: 'v1',
      digest: 'sha256:abc',
    });
  });

  it('handles an empty string', () => {
    expect(splitImageRef('')).toEqual({ repo: '', tag: undefined, digest: undefined });
  });
});
