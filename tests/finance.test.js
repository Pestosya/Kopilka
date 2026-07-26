const test = require("node:test");
const assert = require("node:assert/strict");
const {
  roundMoney,
  operationBalanceImpact,
  operationAnalyticsImpact,
  calculateAccountBalance,
  calculateAccountsTotal,
  creditDebt,
  creditOverpayment,
  availableCredit,
  recurringMonthlyAmount,
  annuityPayment,
  simulateDebtStrategy
} = require("../modules/finance.js");

test("остаток счёта учитывает операции и переводы", () => {
  const account = { id: "main", includeInTotal: true };
  const operations = [
    { accountId: "main", type: "initial_balance", amount: 10000 },
    { accountId: "main", type: "income", amount: 5000 },
    { accountId: "main", type: "expense", amount: 1200 },
    { accountId: "other", type: "expense", amount: 9999 }
  ];
  const transfers = [
    { fromAccountId: "main", toAccountId: "savings", amount: 2000 },
    { fromAccountId: "cash", toAccountId: "main", amount: 300 }
  ];
  assert.equal(calculateAccountBalance(account, operations, transfers), 12100);
});

test("перевод между счетами не меняет общий баланс", () => {
  const accounts = [
    { id: "one", includeInTotal: true },
    { id: "two", includeInTotal: true }
  ];
  const operations = [
    { accountId: "one", type: "initial_balance", amount: 8000 },
    { accountId: "two", type: "initial_balance", amount: 2000 }
  ];
  const transfer = [{ fromAccountId: "one", toAccountId: "two", amount: 1500 }];
  const total = calculateAccountsTotal(accounts, operations, transfer);
  assert.equal(total, 10000);
});

test("комиссия перевода списывается только со счёта отправителя", () => {
  const operations = [
    { accountId: "one", type: "initial_balance", amount: 10000 },
    { accountId: "two", type: "initial_balance", amount: 0 }
  ];
  const transfers = [{ fromAccountId: "one", toAccountId: "two", amount: 1500, fee: 50 }];
  assert.equal(calculateAccountBalance({ id: "one" }, operations, transfers), 8450);
  assert.equal(calculateAccountBalance({ id: "two" }, operations, transfers), 1500);
  assert.equal(calculateAccountsTotal([{ id: "one" }, { id: "two" }], operations, transfers), 9950);
});

test("openingBalance и currentBalance не являются источниками баланса", () => {
  const account = { id: "main", openingBalance: 999999, currentBalance: 123 };
  const operations = [{ accountId: "main", type: "initial_balance", amount: 7000 }];
  assert.equal(calculateAccountBalance(account, operations, []), 7000);
});

test("кредитный лимит не прибавляется к собственным средствам", () => {
  const accounts = [
    { id: "cash", type: "cash", includeInTotal: true },
    { id: "credit", type: "credit_card", includeInTotal: true, creditLimit: 100000 }
  ];
  const operations = [
    { accountId: "cash", type: "initial_balance", amount: 50000 },
    { accountId: "credit", type: "initial_balance", amount: -35000 }
  ];
  assert.equal(calculateAccountsTotal(accounts, operations, []), 15000);
});

test("баланс дебетовой карты считается по операциям и переводам", () => {
  const account = { id: "debit", type: "debit_card", includeInTotal: true };
  const operations = [
    { accountId: "debit", type: "initial_balance", amount: 10000 },
    { accountId: "debit", type: "income", amount: 2500 },
    { accountId: "debit", type: "expense", amount: 700 },
    { accountId: "debit", type: "refund", amount: 200 }
  ];
  const transfers = [{ fromAccountId: "debit", toAccountId: "cash", amount: 1000, fee: 50 }];
  assert.equal(calculateAccountBalance(account, operations, transfers), 10950);
});

test("кредитная карта использует знаковый calculatedBalance для долга и лимита", () => {
  const account = { id: "credit", type: "credit_card", includeInTotal: true, creditLimit: 100000 };
  const operations = [
    { accountId: "credit", type: "initial_balance", amount: -35000 }
  ];
  assert.equal(calculateAccountBalance(account, operations, []), -35000);
  assert.equal(creditDebt(account, operations, []), 35000);
  assert.equal(creditOverpayment(account, operations, []), 0);
  assert.equal(availableCredit(account, operations, []), 65000);
});

test("покупка по кредитке увеличивает долг, а погашение переводом не становится расходом", () => {
  const accounts = [
    { id: "cash", type: "cash", includeInTotal: true },
    { id: "credit", type: "credit_card", includeInTotal: true, creditLimit: 100000 }
  ];
  const operations = [
    { accountId: "cash", type: "initial_balance", amount: 50000 },
    { accountId: "credit", type: "initial_balance", amount: -35000 },
    { accountId: "credit", type: "expense", amount: 2000 }
  ];
  const transfers = [{ fromAccountId: "cash", toAccountId: "credit", amount: 10000 }];
  assert.equal(calculateAccountBalance(accounts[0], operations, transfers), 40000);
  assert.equal(calculateAccountBalance(accounts[1], operations, transfers), -27000);
  assert.equal(creditDebt(accounts[1], operations, transfers), 27000);
  assert.equal(availableCredit(accounts[1], operations, transfers), 73000);
  assert.equal(calculateAccountsTotal(accounts, operations, transfers), 13000);
});

test("refund уменьшает расходы и не является доходом", () => {
  const purchase = { accountId: "credit", type: "expense", amount: 5000 };
  const refund = { accountId: "credit", type: "refund", amount: 1200, relatedOperationId: "purchase-1", category: "Продукты" };
  assert.equal(operationBalanceImpact(purchase), -5000);
  assert.equal(operationBalanceImpact(refund), 1200);
  assert.deepEqual(operationAnalyticsImpact(purchase), { income: 0, expense: 5000 });
  assert.deepEqual(operationAnalyticsImpact(refund), { income: 0, expense: -1200 });
});

test("чистый капитал учитывает долг кредитной карты отрицательно", () => {
  const accounts = [
    { id: "debit", type: "debit_card", includeInTotal: true },
    { id: "savings", type: "savings", includeInTotal: true },
    { id: "hidden", type: "wallet", includeInTotal: false },
    { id: "credit", type: "credit_card", includeInTotal: true, creditLimit: 300000 }
  ];
  const operations = [
    { accountId: "debit", type: "initial_balance", amount: 40000 },
    { accountId: "savings", type: "initial_balance", amount: 25000 },
    { accountId: "hidden", type: "initial_balance", amount: 999999 },
    { accountId: "credit", type: "initial_balance", amount: -12000 }
  ];
  assert.equal(calculateAccountsTotal(accounts, operations, []), 53000);
});

test("регулярные платежи приводятся к месячной сумме", () => {
  assert.equal(roundMoney(recurringMonthlyAmount({ amount: 1200, frequency: "yearly" })), 100);
  assert.equal(roundMoney(recurringMonthlyAmount({ amount: 300, frequency: "weekly" })), 1300);
  assert.equal(recurringMonthlyAmount({ amount: 900, frequency: "monthly" }), 900);
});

test("аннуитетный платёж рассчитывается для ставки и нулевой ставки", () => {
  assert.equal(annuityPayment(120000, 0, 12), 10000);
  assert.equal(annuityPayment(100000, 12, 12), 8884.88);
});

test("снежный ком и лавина выбирают разные первые долги", () => {
  const debts = [
    { id: "small", name: "Небольшой долг", balance: 10000, rate: 5, payment: 1000 },
    { id: "expensive", name: "Дорогой кредит", balance: 50000, rate: 20, payment: 1500 }
  ];
  const snowball = simulateDebtStrategy(debts, "snowball", 2000);
  const avalanche = simulateDebtStrategy(debts, "avalanche", 2000);
  assert.equal(snowball.priorityOrder[0].id, "small");
  assert.equal(avalanche.priorityOrder[0].id, "expensive");
  assert.ok(avalanche.totalInterest < snowball.totalInterest);
  assert.equal(snowball.complete, true);
  assert.equal(avalanche.complete, true);
});
