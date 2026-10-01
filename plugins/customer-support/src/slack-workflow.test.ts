import assert from "node:assert/strict";
import test from "node:test";
import { IntakeError, resolveConnection, type Config } from "./routing.js";
import { parseSlackWorkflowPost } from "./slack-workflow.js";

const companyA = "11111111-1111-4111-8111-111111111111";
const companyB = "22222222-2222-4222-8222-222222222222";
const config: Config = { connections: [{
  id: "example-workspace", source: "slack", externalAccountId: "TEXAMPLE01", ingestAgentId: "agent-1",
  allowedCompanies: [companyA, companyB], routes: [
    { externalRouteId: "CEXAMPLE01:companyalpha", companyId: companyA },
    { externalRouteId: "CEXAMPLE01:companybeta", companyId: companyB },
    { externalRouteId: "CEXAMPLE02:companyalpha", companyId: companyA },
    { externalRouteId: "CEXAMPLE02:companybeta", companyId: companyB },
  ],
}] };

function post(company: string, channelId = "CEXAMPLE01", companyId = companyA) {
  return parseSlackWorkflowPost({
    companyId, connectionId: "example-workspace", externalAccountId: "TEXAMPLE01",
    channelId, messageTs: "1700000000.000100", text: `Help Desk Request Manager: New Help Desk Request\n\nCompany: ${company}\nRequest: Checkout error\nDetails: Error on the order page`,
  });
}

test("both workflows route explicit Company Alpha and Company Beta answers", () => {
  for (const channel of ["CEXAMPLE01", "CEXAMPLE02"]) {
    assert.equal(resolveConnection(config, post("Company Alpha", channel)).source, "slack");
    assert.equal(resolveConnection(config, post("Company Beta", channel, companyB)).source, "slack");
  }
  assert.equal(post("Company Alpha").title, "Checkout error");
  assert.equal(post("Company Alpha").authorKind, "staff");
  const bold = parseSlackWorkflowPost({
    companyId: companyA, connectionId: "example-workspace", externalAccountId: "TEXAMPLE01",
    channelId: "CEXAMPLE01", messageTs: "1700000000.000100", text: "*Company:* Company Alpha\n*Request:* Help",
  });
  assert.equal(bold.externalRouteId, "CEXAMPLE01:companyalpha");
});

test("a selection cannot route into the wrong Paperclip company", () => {
  assert.throws(() => resolveConnection(config, post("Company Beta", "CEXAMPLE01", companyA)), IntakeError);
});

test("old posts without Company and repeated or unknown selections fail closed", () => {
  const base = {
    companyId: companyA, connectionId: "example-workspace", externalAccountId: "TEXAMPLE01",
    channelId: "CEXAMPLE01", messageTs: "1700000000.000100",
  };
  assert.throws(() => parseSlackWorkflowPost({ ...base, text: "Request: Help" }), IntakeError);
  assert.throws(() => parseSlackWorkflowPost({ ...base, text: "Company: Company Alpha\nCompany: Company Beta\nRequest: Help" }), IntakeError);
  assert.throws(() => resolveConnection(config, post("Unlisted Business")), IntakeError);
});
