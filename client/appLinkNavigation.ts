export interface AppLinkLocation {
  assign(url: string): void;
}

export function openAppLink(
  url: string,
  location: AppLinkLocation = window.location
): void {
  location.assign(url);
}