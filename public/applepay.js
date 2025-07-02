document.addEventListener("DOMContentLoaded", async () => {
  if (!window.ApplePaySession) return;

  const cfg = JSON.parse(
    document.getElementById("applepay-config").textContent
  );

  const canPay = await ApplePaySession.canMakePaymentsWithActiveCard(
    cfg.merchant_id
  );
  if (!canPay) return;

  document
    .querySelectorAll("apple-pay-button")
    .forEach((btn) =>
      btn.addEventListener("click", () => initiateApplePay(cfg))
    );
});

function initiateApplePay(cfg) {
  const paymentRequest = {
    countryCode: "US",
    currencyCode: cfg.currency,
    supportedNetworks: cfg.supported_networks,
    merchantCapabilities: ["supports3DS"],
    total: {
      label: cfg.display_name,
      amount: "10.00",
    },
  };

  const session = new ApplePaySession(3, paymentRequest);

  session.onvalidatemerchant = async (evt) => {
    try {
      const r = await fetch("/applepay/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ validationURL: evt.validationURL }),
      });
      session.completeMerchantValidation(await r.json());
    } catch (err) {
      console.error(err);
      session.abort();
    }
  };

  session.onpaymentauthorized = async (evt) => {
    const payload = {
      token: evt.payment.token,
      row_id: getRowId(),
      amount: paymentRequest.total.amount,
      currency: paymentRequest.currencyCode,
    };

    try {
      const r = await fetch("/applepay/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const { status, row_id } = await r.json();

      session.completePayment(
        status === "success"
          ? ApplePaySession.STATUS_SUCCESS
          : ApplePaySession.STATUS_FAILURE
      );

      if (status === "success") {
        window.location.href = `/view/Apple%20Pay%20Callback?status=success&row_id=${row_id}`;
      }
    } catch (err) {
      console.error(err);
      session.completePayment(ApplePaySession.STATUS_FAILURE);
    }
  };

  session.begin();
}

function getRowId() {
  return (
    document.body.dataset.rowId ||
    document.querySelector("apple-pay-button")?.dataset.rowId
  );
}
