module.exports = async function handler(req, res) {
  const apiKey = process.env.AIRTABLE_API_KEY;
  const baseId = process.env.AIRTABLE_BASE_ID;

  if (!apiKey || !baseId) {
    return res.status(500).json({ error: 'Airtable configuration missing' });
  }

  const tableName = req.query.table;
  if (!tableName) {
    return res.status(400).json({ error: 'Table name required' });
  }

  const filterByFormula = req.query.filterByFormula || '';
  const sort = req.query.sort || '';
  const offset = req.query.offset || '';

  try {
    let url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(tableName)}?pageSize=100`;
    if (filterByFormula) url += `&filterByFormula=${encodeURIComponent(filterByFormula)}`;
    if (sort) url += `&${sort}`;
    if (offset) url += `&offset=${encodeURIComponent(offset)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` }
    });

    if (!response.ok) {
      const errText = await response.text();
      return res.status(response.status).json({ error: errText });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
