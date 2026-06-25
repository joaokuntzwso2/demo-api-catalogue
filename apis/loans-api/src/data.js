function accounts(customerId) {
  return [
    { accountId: 'ACC-1001', customerId, type: 'CHECKING', balance: 12840.55, currency: 'BRL', status: 'ACTIVE' },
    { accountId: 'ACC-1002', customerId, type: 'SAVINGS', balance: 50200.10, currency: 'BRL', status: 'ACTIVE' }
  ];
}

function transactions(accountId) {
  return [
    { transactionId: 'TX-9001', accountId, amount: -120.45, type: 'PIX', status: 'SETTLED' },
    { transactionId: 'TX-9002', accountId, amount: 2500.00, type: 'TED', status: 'SETTLED' }
  ];
}

function payment(paymentId) {
  return { paymentId, type: 'PIX', amount: 320.75, currency: 'BRL', status: 'AUTHORIZED' };
}

function createPayment(body) {
  return { paymentId: 'PAY-' + Math.floor(Math.random() * 9000 + 1000), status: 'CREATED', ...body };
}

function customer(customerId) {
  return { customerId, name: 'Maria Oliveira', segment: 'PRIVATE_BANKING', kycStatus: 'VERIFIED' };
}

function profile(customerId) {
  return { customerId, riskRating: 'LOW', relationshipSince: '2018-04-12', preferredChannel: 'DIGITAL' };
}

function cards(customerId) {
  return [
    { cardId: 'CARD-1001', customerId, brand: 'VISA', status: 'ACTIVE' },
    { cardId: 'CARD-1002', customerId, brand: 'MASTERCARD', status: 'BLOCKED' }
  ];
}

function cardLimits(cardId) {
  return { cardId, totalLimit: 45000, availableLimit: 18200, currency: 'BRL' };
}

function loans(customerId) {
  return [
    { loanId: 'LOAN-1001', customerId, product: 'PERSONAL_CREDIT', outstandingBalance: 15000, status: 'ACTIVE' }
  ];
}

function loanSimulation(body) {
  const amount = Number(body.amount || 10000);
  return { simulationId: 'SIM-' + Math.floor(Math.random() * 9000 + 1000), requestedAmount: amount, monthlyInstallment: Number((amount / 24 * 1.045).toFixed(2)), termMonths: 24 };
}

module.exports = { accounts, transactions, payment, createPayment, customer, profile, cards, cardLimits, loans, loanSimulation };
