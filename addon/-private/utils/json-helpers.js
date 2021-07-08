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

  return new Promise((resolve) => {
    if (responseType.includes('json')) {
      console.error('responseType.includes(\'json\')');
      return response.json()
        .then((json) => {
          if (response.ok) {
            console.error('responseType.includes(\'json\') - response.ok');
            return resolve({
              status: response.status,
              ok: response.ok,
              json
            });
          } else {
            console.error('responseType.includes(\'json\') - else');
            error = Object.assign({}, json, error);

            return resolve(error);
          }
        })
        .catch((err) => {
          console.error('responseType.includes(\'json\') - catch');
          if (isJsonString(error.message)) {
            console.error('responseType.includes(\'json\') - catch - if');
            error.payload = JSON.parse(error.message);
          } else {
            console.error('responseType.includes(\'json\') - catch - else');
            error.payload = error.message || err.toString();
          }

          error.message = error.message || err.toString();

          return resolve(error);
        });
    } else {
      return response.text()
        .then((text) => {
          console.error('text - then');
          return resolve({
            status: response.status,
            ok: response.ok,
            text
          });
        })
        .catch((err) => {
          if (isJsonString(error.message)) {
            console.error('text - catch - isJsonString');
            error.payload = JSON.parse(error.message);
          } else {
            console.error('text - catch - else');
            error.payload = error.message || err.toString();
          }

          error.message = error.message || err.toString();

          return resolve(error);
        });
    }
  });
}
