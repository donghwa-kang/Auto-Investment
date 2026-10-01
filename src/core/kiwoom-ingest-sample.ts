import {
  KIWOOM_SPEC_COMMIT,
  type KiwoomInput,
} from "./kiwoom-ingest-schema.js";

// 직접 작성한 가상 값이며 공급자 예시/시세 응답을 복제한 자료가 아니다.
export function kiwoomMockSample(): KiwoomInput {
  const base = {
    connectionEpoch: 0,
    requestContinuation: { contYn: "N" as const, nextKey: "" },
    responseContinuation: { contYn: "N" as const, nextKey: "" },
    requestedAt: "2026-09-21T14:00:00Z",
    receivedAt: "2026-09-21T14:00:00.100Z",
    availableAt: "2026-09-21T14:00:00.200Z",
    outcome: "RESPONSE" as const,
    httpStatus: 200,
  };
  return {
    schemaVersion: "OFFLINE_KIWOOM_INGEST_V1",
    purpose: "MOCK_CONTRACT",
    dataOrigin: "MOCK_RESPONSE",
    source: "KIWOOM_REST",
    sourceSpecCommit: KIWOOM_SPEC_COMMIT,
    asOf: "2026-09-21T14:00:01Z",
    pagePlans: [],
    captures: [
      {
        ...base,
        captureId: "kr-bar",
        request: {
          apiId: "ka10080",
          body: { stk_cd: "111111", tic_scope: "1", upd_stkpc_tp: "0" },
        },
        responseApiId: "ka10080",
        response: {
          return_code: 0,
          stk_cd: "111111",
          stk_min_pole_chart_qry: [
            {
              open_pric: "-10000",
              high_pric: "-10050",
              low_pric: "-9990",
              cur_prc: "-10010",
              trde_qty: "10",
              cntr_tm: "20260921100000",
            },
          ],
        },
      },
      {
        ...base,
        captureId: "us-bar",
        request: {
          apiId: "usa06011",
          body: {
            stex_tp: "ND",
            stk_cd: "TEST",
            tic_scope: "1",
            upd_stkpc_tp: "0",
            exrt_appl_tp: "0",
          },
        },
        responseApiId: "usa06011",
        response: {
          return_code: 0,
          result_list: [
            {
              open_pric: "100.0000",
              high_pric: "101.0000",
              low_pric: "99.0000",
              cur_prc: "100.5000",
              trde_qty: "20",
              cntr_tm: "20260921093000",
              bus_dt: "20260921",
              upd_stkpc_tp: "",
              upd_rt: "",
            },
          ],
        },
      },
      {
        ...base,
        captureId: "kr-book",
        request: { apiId: "ka10004", body: { stk_cd: "111111" } },
        responseApiId: "ka10004",
        response: {
          return_code: 0,
          bid_req_base_tm: "100001",
          sel_fpr_bid: "+10010",
          buy_fpr_bid: "-10000",
          sel_fpr_req: "10",
          buy_fpr_req: "20",
        },
      },
      {
        ...base,
        captureId: "us-book",
        request: { apiId: "usa20101", body: { stex_tp: "ND", stk_cd: "TEST" } },
        responseApiId: "usa20101",
        response: {
          return_code: 0,
          stk_cd: "TEST",
          stex_tp: "ND",
          dt: "20260921",
          bid_tm: "09:30",
          sel_1bid: "+100.5100",
          buy_1bid: "+100.5000",
          sel_1bid_req: "10",
          buy_1bid_req: "20",
        },
      },
    ],
  };
}
