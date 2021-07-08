/**
 * Determine if a string is JSON or not
 * @param {string} str The string to check for JSON formatting
 * @return {boolean}
 * @function isJsonString
 * @private
 */
export function isJsonString(str) {
  try {
    const json = JSON.parse(str);
    return (typeof json === 'object');
  } catch(e) {
    return false;
  }
}

/**
 * Parses the JSON returned by a network request
 *
 * @param  {object} response A response from a network request
 * @return {object} The parsed JSON, status from the response
 * @function parseJSON
 * @private
 */
export async function parseJSON(response) {
  const responseType = response.headers.get('content-type') || 'Empty Content-Type';
  let error;

  if (!response.ok) {
    console.error('!response.ok');
    const errorBody = await response.text();
    error = {
      message: errorBody,
      status: response.status,
      statusText: response.statusText
    };
  }

  if (responseType.includes('json')) {
    try {
      let json = await response.json();
      if (response.ok) {
        console.error('responseType.includes(\'json\') - response.ok');
        return {
          status: response.status,
          ok: response.ok,
          json
        };
      } else {
        console.error('responseType.includes(\'json\') - else');
        error = Object.assign({}, json, error);
        return error;
      }
    } catch (err) {
      if (isJsonString(error.message)) {
        console.error('responseType.includes(\'json\') - catch - if');
        error.payload = JSON.parse(error.message);
      } else {
        console.error('responseType.includes(\'json\') - catch - else');
        error.payload = error.message || err.toString();
      }

      error.message = error.message || err.toString();
      return error;
    }
  } else {
    try {
      let text = await response.text();

      return {
        status: response.status,
        ok: response.ok,
        text
      };
    } catch (err) {
      if (isJsonString(error.message)) {
        console.error('text - catch - isJsonString');
        error.payload = JSON.parse(error.message);
      } else {
        console.error('text - catch - else');
        error.payload = error.message || err.toString();
      }

      error.message = error.message || err.toString();

      return error;
    }
  }
}
