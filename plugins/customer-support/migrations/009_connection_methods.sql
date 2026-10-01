-- Record the verified WMI/DCOM plus SMB path and interactive RDP separately.
ALTER TABLE plugin_customer_support_0c69412611.support_cases
  DROP CONSTRAINT support_cases_access_method_check;

ALTER TABLE plugin_customer_support_0c69412611.support_cases
  ADD CONSTRAINT support_cases_access_method_check
  CHECK (access_method IN (
    'unknown', 'winrm', 'winrm_https', 'wmi_dcom_smb', 'ssh', 'smb', 'rdp', 'rmm', 'local', 'other'
  ));
