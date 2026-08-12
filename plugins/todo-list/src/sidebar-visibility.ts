import { isCompanyAllowed } from "./companyAccess.js";

export interface SidebarConfig {
  allowedCompanies?: string[];
  showInSidebar?: boolean;
  showCaptureBox?: boolean;
}

export interface SidebarVisibility {
  /** Whether the sidebar entry renders at all. */
  visible: boolean;
  /** Whether the inline one-line capture input renders under the entry. */
  capture: boolean;
  reason: string;
}

/**
 * Decide what the sidebar shows for the company currently on screen.
 *
 * Both toggles default to on. The capture box can be turned off on its own for
 * anyone who wants the nav link without a text field taking up sidebar room,
 * but it can never show while the entry itself is hidden.
 */
export function computeSidebarVisibility(
  companyId: string | null,
  config: SidebarConfig,
): SidebarVisibility {
  if (!companyId) {
    return { visible: false, capture: false, reason: "no-company" };
  }
  if (config.showInSidebar === false) {
    return { visible: false, capture: false, reason: "hidden-by-config" };
  }
  if (!isCompanyAllowed(config.allowedCompanies, companyId)) {
    return { visible: false, capture: false, reason: "company-not-allow-listed" };
  }
  return {
    visible: true,
    capture: config.showCaptureBox !== false,
    reason: "ok",
  };
}
