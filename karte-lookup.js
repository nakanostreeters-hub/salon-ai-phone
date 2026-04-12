// karte-lookup.js
// カルテくんCSVデータ検索モジュール
const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse/sync');

class KarteLookup {
  constructor() {
    // 電話番号 → カルテデータ
    this.karteByPhone = new Map();
    // カルテ番号 → カルテデータ
    this.karteById = new Map();
    // カルテ番号 → 来店記録[]
    this.visitsByKarteId = new Map();
    // 来店記録番号 → 施術データ[]
    this.treatmentsByVisitId = new Map();
    this.loaded = false;
  }

  // 電話番号を正規化（ハイフン除去、+81→0変換）
  normalizePhone(phone) {
    if (!phone) return '';
    let p = phone.replace(/[\s\-\(\)]/g, '');
    if (p.startsWith('+81')) {
      p = '0' + p.slice(3);
    }
    return p;
  }

  // BOM付きUTF-8ファイルを読み込み
  readCsvFile(filePath) {
    let content = fs.readFileSync(filePath, 'utf-8');
    // BOM除去
    if (content.charCodeAt(0) === 0xFEFF) {
      content = content.slice(1);
    }
    return parse(content, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  }

  // 3つのCSVを読み込み
  load(dataDir) {
    const dir = dataDir || path.join(__dirname, 'data');

    console.log('[KarteLookup] CSVデータ読み込み中...');

    // 1. カルテデータ
    const karteRows = this.readCsvFile(path.join(dir, 'カルテデータ.csv'));
    for (const row of karteRows) {
      const phone = this.normalizePhone(row['電話番号']);
      const karteId = row['カルテ番号'];
      const data = {
        karteId,
        name: row['お客様名'],
        reading: row['よみがな'],
        gender: row['性別'],
        allergies: row['アレルギー等の注意事項'],
        memo: row['メモ'],
        phone,
        lastVisit: row['最終来店日時'],
        lastStaff: row['最終担当スタッフ'],
        visitCount: parseInt(row['来店回数']) || 0,
        totalSpend: parseInt(row['総支払額']) || 0,
        visitCycle: row['来店周期(日数)'],
        segment: row['顧客セグメント'],
        firstVisit: row['初回来店日時'],
      };
      this.karteById.set(karteId, data);
      if (phone) {
        this.karteByPhone.set(phone, data);
      }
      // メモ欄に電話番号が書かれているケースもフォールバックで登録
      if (!phone && data.memo) {
        const phoneMatch = data.memo.match(/0[0-9]{9,10}/);
        if (phoneMatch) {
          data.phone = phoneMatch[0];
          this.karteByPhone.set(phoneMatch[0], data);
        }
      }
    }

    // 2. 来店記録データ
    const visitRows = this.readCsvFile(path.join(dir, '来店記録データ.csv'));
    for (const row of visitRows) {
      const karteId = row['カルテ番号'];
      const visitId = row['来店記録番号'];
      const visit = {
        visitId,
        staff: row['主担当'],
        startTime: row['開始時刻'],
        endTime: row['終了時刻'],
        isNomination: row['指名フラグ'] === '1',
        memo: row['メモ'],
        visitNumber: parseInt(row['訪問回数']) || 0,
        totalTreatment: parseInt(row['施術合計売上(税込)']) || 0,
        totalRetail: parseInt(row['店販合計売上(税込)']) || 0,
        customerName: row['お客様名'],
      };
      if (!this.visitsByKarteId.has(karteId)) {
        this.visitsByKarteId.set(karteId, []);
      }
      this.visitsByKarteId.get(karteId).push(visit);
    }

    // 3. 来店記録施術_店販データ
    const treatmentRows = this.readCsvFile(path.join(dir, '来店記録施術_店販データ.csv'));
    for (const row of treatmentRows) {
      const visitId = row['来店記録番号'];
      const treatment = {
        name: row['名前'],
        category: row['大カテゴリ'],
        subCategory: row['小カテゴリ'],
        price: parseInt(row['売上(税込)']) || 0,
        staff: row['担当者1'],
      };
      if (!this.treatmentsByVisitId.has(visitId)) {
        this.treatmentsByVisitId.set(visitId, []);
      }
      this.treatmentsByVisitId.get(visitId).push(treatment);
    }

    // 来店記録を日付降順にソート
    for (const [, visits] of this.visitsByKarteId) {
      visits.sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
    }

    this.loaded = true;
    console.log(`[KarteLookup] 読み込み完了: カルテ ${this.karteById.size}件, 来店記録 ${visitRows.length}件, 施術データ ${treatmentRows.length}件`);
  }

  // 電話番号で検索
  findByPhone(phone) {
    const normalized = this.normalizePhone(phone);
    if (!normalized) return null;
    return this.karteByPhone.get(normalized) || null;
  }

  // カルテの来店記録を取得（直近N件）
  getVisits(karteId, limit = 5) {
    const visits = this.visitsByKarteId.get(karteId) || [];
    return visits.slice(0, limit);
  }

  // 来店記録の施術データを取得
  getTreatments(visitId) {
    return this.treatmentsByVisitId.get(visitId) || [];
  }

  // AIシステムプロンプト用のコンテキスト文字列を生成
  buildContext(phone) {
    const karte = this.findByPhone(phone);
    if (!karte) return null;

    const lines = [];
    lines.push(`## このお客様の情報（カルテくんより）`);
    lines.push(`- お名前: ${karte.name}（${karte.reading}）`);
    lines.push(`- 性別: ${karte.gender}`);
    if (karte.visitCount > 0) {
      lines.push(`- 来店回数: ${karte.visitCount}回`);
    }
    if (karte.lastVisit) {
      lines.push(`- 最終来店: ${karte.lastVisit}`);
    }
    if (karte.lastStaff) {
      lines.push(`- 前回担当: ${karte.lastStaff}`);
    }
    if (karte.segment) {
      lines.push(`- 顧客セグメント: ${karte.segment}`);
    }
    if (karte.visitCycle) {
      lines.push(`- 来店周期: 約${karte.visitCycle}日`);
    }
    if (karte.allergies) {
      lines.push(`- ⚠ 注意事項: ${karte.allergies}`);
    }
    if (karte.memo) {
      lines.push(`- メモ: ${karte.memo}`);
    }

    // 直近の来店記録
    const visits = this.getVisits(karte.karteId, 3);
    if (visits.length > 0) {
      lines.push('');
      lines.push('### 直近の来店記録');
      for (const visit of visits) {
        const date = visit.startTime ? visit.startTime.split(' ')[0] : '不明';
        const treatments = this.getTreatments(visit.visitId);
        const menuNames = treatments.map(t => t.name).join('、') || '記録なし';
        const nomination = visit.isNomination ? '（指名）' : '';
        lines.push(`- ${date}: ${menuNames} / 担当: ${visit.staff}${nomination}`);
        if (visit.memo) {
          // メモは長い場合があるので先頭100文字まで
          const memo = visit.memo.replace(/\n/g, ' ').slice(0, 100);
          lines.push(`  メモ: ${memo}`);
        }
      }
    }

    lines.push('');
    lines.push('### 対応上の注意');
    lines.push('- 上記の顧客情報を踏まえて、パーソナライズされた対応をしてください');
    lines.push('- 前回の施術内容やスタッフ名に触れると好印象です');
    lines.push('- 顧客情報を知っていることを不自然にアピールしないでください');

    return lines.join('\n');
  }
}

module.exports = KarteLookup;
