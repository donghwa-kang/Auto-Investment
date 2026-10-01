// 자식 CLI 시험 전용. 실제 네트워크 대신 고정 모형 응답만 제공한다.
// 제품 CLI에서는 이 파일을 import하지 않는다.
globalThis.fetch = async (input, init) => {
  const url = new URL(String(input));
  if (url.origin !== "https://openapi.tossinvest.com")
    throw new Error("MOCK_HOST_REJECTED");
  const json = (value, status = 200) =>
    new Response(JSON.stringify(value), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  if (url.pathname === "/oauth2/token" && init.method === "POST") {
    const body = new URLSearchParams(init.body);
    if (
      body.get("client_id") !== "FAKE_CLIENT_123456" ||
      body.get("client_secret") !== "FAKE_SECRET_123456"
    )
      throw new Error("MOCK_CREDENTIAL_REJECTED");
    if (process.env.TEST_TOSS_CATALOG_RESPONSE === "HOLD") {
      process.send?.("MOCK_AUTH_REACHED");
      // 강제 종료 시험이 소유한 자식만 대기한다. 실제 네트워크 호출은 없다.
      await new Promise((done) => setTimeout(done, 60000));
    }
    return json({
      access_token: "FAKE_TOKEN_TEST_ONLY",
      token_type: "Bearer",
      expires_in: 3600,
    });
  }
  if (url.pathname === "/api/v1/stocks/all" && init.method === "GET") {
    if (process.env.TEST_TOSS_CATALOG_RESPONSE === "FAIL") return json({}, 429);
    return json({
      result: [
        {
          symbol: "SAMPLE",
          name: "시험 종목",
          securityType: "ETF",
          isCommonShare: true,
          isinCode: "US0000000002",
        },
      ],
    });
  }
  throw new Error("MOCK_PATH_REJECTED");
};
