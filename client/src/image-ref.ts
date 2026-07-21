export interface ImageRef {
  /** Registry + repository, e.g. `ghcr.io/acme/app`. */
  repo: string;
  tag?: string;
  digest?: string;
}

/**
 * Split an image reference into repo, tag and digest. A `:` only counts as the
 * tag separator when it appears after the last `/`, so registry ports
 * (`localhost:5000/app`) stay part of the repo.
 */
export function splitImageRef(image: string): ImageRef {
  const at = image.indexOf('@');
  const digest = at >= 0 ? image.slice(at + 1) : undefined;
  let repo = at >= 0 ? image.slice(0, at) : image;
  let tag: string | undefined;
  const colon = repo.lastIndexOf(':');
  if (colon > repo.lastIndexOf('/')) {
    tag = repo.slice(colon + 1);
    repo = repo.slice(0, colon);
  }
  return { repo, tag, digest };
}
