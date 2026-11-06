import './styles/main.css';

const startupStatus = document.querySelector<HTMLParagraphElement>('#startup-status');

if (!startupStatus) {
  throw new Error('起動状態の表示先が見つかりません。');
}

startupStatus.textContent = '開発環境の起動を確認しました。';
