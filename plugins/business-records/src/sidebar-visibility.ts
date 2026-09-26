import { isCompanyAllowed } from "./companyAccess.js";

export interface InstanceConfig {
  allowedCompanies?: string[];
  showInSidebar?: boolean;
}

export interface SidebarVisibility {
  visible: boolean;
  reason: string;
}

/** Whether the Corporate Operations sidebar entry shows for the company on screen. */
export function computeSidebarVisibility(companyId: string | null, config: InstanceConfig): SidebarVisibility {
  if (!companyId) return { visible: false, reason: "no-company" };
  if (config.showInSidebar === false) return { visible: false, reason: "hidden-by-config" };
  if (!isCompanyAllowed(config.allowedCompanies, companyId)) {
    return { visible: false, reason: "company-not-allow-listed" };
  }
  return { visible: true, reason: "ok" };
}
